var swig  = require('swig');
var pathlib  = require('path');
var async = require('async');

var patches = require("./patches.js");
var repo = require("./repository.js");
var settings = require("./settings.js");
var publish = require("./publish.js");

String.prototype.repeat = function( num ) { return new Array( num + 1 ).join( this ); }

exports.getUser = function(username) {
	for (var i = 0; i < settings.authorized_users.length; i++) {
		if (username == settings.authorized_users[i].username)
			return settings.authorized_users[i];
	}
	return null;
}

exports.set_routes = function(app) {
	// Home Screen
	var home_template = swig.compileFile(__dirname + '/templates/index.html');
	app.get('/', function(req, res){
		res.setHeader('Content-Type', 'text/html');

		async.parallel({
			patch_tree: function(callback) {
				patches.getTree(function(patch_tree) { callback(null, patch_tree) });
				},
			workspace_is_dirty: function(callback) {
				repo.is_working_tree_dirty(settings.workspace_directory, function(is_dirty) { callback(null, is_dirty) });
				}
			},
			function(err, results) {
				res.send(home_template({
					csrf_token: req.csrfToken(), // passed to every template

					patch_tree: results.patch_tree,
					head_patch: results.patch_tree[0][0],
					workspace_is_dirty: results.workspace_is_dirty
				}));
			}
		)

	});

	// Patch Edit
	var show_patch_template = swig.compileFile(__dirname + '/templates/patch.html');
	app.get('/patch/:patch', function(req, res){
		res.setHeader('Content-Type', 'text/html');

		var patch = patches.Patch.load(req.params.patch);

		async.parallel(
		{
			// get the base patch
			base: function(callback) {
				if (patch.type == "root") { callback(null, null); return; }
				patch.getBase(function(base_patch) { callback(null, base_patch); });
			},

			// get the list of editable files
			file_list: function(callback) {
				patch.getPaths(
					req.query.path, false /* not recursive */, true /* with deleted files */,
					function(file_list) {
						patches.sort_paths(file_list);
						callback(null, file_list); // null=no error
					});
				},

			// get a diff of the changes made by this patch
			diffs: function(callback) { patch.getDiff(function(diffinfo) { callback(null, diffinfo); } ); }
		},
		function(err, result) {
			// for navigating the files, which is the parent directory path?
			var path_up = null;
			if (req.query.path)
				path_up = pathlib.dirname(req.query.path);

			res.send(show_patch_template({
				csrf_token: req.csrfToken(), // passed to every template

				patch: patch,
				readonly: (patch.type == "root") || (patch.children.length > 0),

				notes: render_patch_notes(patch),
				files: result.file_list,

				path: req.query.path,
				path_up: path_up,
				base_patch: result.base,

				diffs: result.diffs,

				macros: get_macros("patch")
			}));
		});
	});

	// New Patch
	app.post('/patch/:patch/_new', function(req, res){
		var patch = patches.Patch.load(req.params.patch);

		// What to name it?
		var base_name = null; // 'new patch'
		if (req.body.reason == "revision")
			base_name = patch.id + "-revision";
		else if (req.body.name)
			base_name = req.body.name;

		patch = patch.createChild(base_name);

		if (!req.body.file)
			res.redirect(patch.edit_url);
		else
			res.redirect(patch.edit_url + "/editor?file=" + req.body.file);
	});

	// Rename/Delete/Modify Patch
	app.post('/patch/:patch/_action', function(req, res){
		var patch = patches.Patch.load(req.params.patch);
		var response = { "status": "ok" };

		if (req.body.action == "rename") {
			var new_id = req.body.value;
			patch.rename(new_id, function(status, new_patch) {
				res.setHeader('Content-Type', 'application/json');
				if (!status) {
					res.send(JSON.stringify({
						"status": "ok",
						"redirect": new_patch.edit_url
					}));
				} else {
					res.send(JSON.stringify({
						"status": "error",
						"msg": status
					}));
				}
			});
			return;
		}

		if (req.body.action == "delete") {
			patch.delete(function(status, num_paths_modified) {
				res.setHeader('Content-Type', 'application/json');
				if (num_paths_modified && !req.body.force) {
					// did not delete, but deletion is possible with force
					res.send(JSON.stringify({
						"status": "ok",
						"msg": "There are " + num_paths_modified + " files modified in this patch. Are you sure you want to delete it?",
						"can_delete_with_force": true
					}));
				} else if (!status) {
					res.send(JSON.stringify({
						"status": "ok",
						"redirect": "/"
					}));
				} else {
					res.send(JSON.stringify({
						"status": "error",
						"msg": status
					}));
				}
			}, req.body.force);
			return;
		}

		if (req.body.action == "notes") {
			patch.notes = req.body.value;
			patch.save();
			response["markdown"] = render_patch_notes(patch);
		}

		if (req.body.action == "effdate") {
			patch.effective_date = req.body.value;
			patch.save();
		}

		if (req.body.action == "draft") {
			patch.draft = (req.body.value == 'true');
			patch.save();
		}

		if (req.body.action == "metadata") {
			patch.metadata[req.body.key] = req.body.value;
			patch.save();
		}

		if (req.body.action == "move") {
			// Move a patch to be the child of another patch.
			var new_base_patch = patches.Patch.load(req.body.new_base);
			var mgmt = require("./management.js");
			mgmt.move_to(patch, new_base_patch, function(status) {
				res.setHeader('Content-Type', 'application/json');
				if (!status) {
					// success
					res.send(JSON.stringify({
						"status": "ok"
					}));
				} else {
					res.send(JSON.stringify({
						"status": "error",
						"msg": status
					}));
				}
			});
			return;
		}

		res.setHeader('Content-Type', 'application/json');
		res.send(JSON.stringify(response));
	});

	function render_patch_notes(patch) {
		var markdown = require( "markdown" ).markdown;
		var notes = patch.notes;
		if (!/\S/.test(notes)) notes = "*no notes*";
		return markdown.toHTML(notes + " EDITLINKSENTINEL").replace("EDITLINKSENTINEL", " [<a href='#' onclick='return edit_patch_notes();'>edit</a>]");
	}

	function spaces_to_tabs(str) {
		return str.replace(/\n(  )+/g, function(m) { return "\n" + "\t".repeat((m.length-1)/2); });
	}
	function tabs_to_spaces(str) {
		return str.replace(/\n(\t)+/g, function(m) { return "\n" + "  ".repeat(m.length-1); });
	}

	// File Edit
	var edit_path_template = swig.compileFile(__dirname + '/templates/path.html');
	app.get('/patch/:patch/editor', function(req, res){
		res.setHeader('Content-Type', 'text/html');
		var patch = patches.Patch.load(req.params.patch);
		var filename = req.query.file;

		var has_base_text = (patch.type != "root");

		async.parallel(
			{
				content: function(callback) {
					patch.getPathContent(filename, has_base_text, function(base_text, current_text, base_patch) {
						callback(null, { base_text: base_text, current_text: current_text, base_patch: base_patch } );
					});
				},
				children: function(callback) {
					patch.getChildren(function(children) { callback(null, children); });
				}
			},
			function(err, resources) {
				// make display nicer
				if (has_base_text) resources.content.base_text = spaces_to_tabs(resources.content.base_text);
				resources.content.current_text = spaces_to_tabs(resources.content.current_text);

				res.send(edit_path_template({
					csrf_token: req.csrfToken(), // passed to every template

					patch: patch,
					readonly: !has_base_text || (patch.children.length > 0),
					filename: filename,
					dirname: pathlib.dirname(filename),
					parentfilename: get_parent_path(filename),
					base_patch: resources.content.base_patch,
					child_patches: resources.children,
					base_text: JSON.stringify(resources.content.base_text),
					current_text: resources.content.current_text
				}));
			}
		);
	});

	// Save a modified file in a patch.
	app.post('/save-patch-file', function(req, res){
		var patch = patches.Patch.load(req.body.patch);
		var filename = req.body.file;
		var newtext = req.body.text;

		if (!patch.can_modify)
			throw "Cannot modify a root patch or a patch that has children.";

		newtext = tabs_to_spaces(newtext);

		patch.writePathContent(filename, newtext)

		res.setHeader('Content-Type', 'application/json');
		res.send(JSON.stringify({
			"status": "ok",
		}));
	});

	// Create a new modified path in a patch. Actually there's nothing to do
	// but redirect to the editor.
	app.post('/new-patch-file', function(req, res){
		var patch = patches.Patch.load(req.body.patch);
		var filename = req.body.file;

		res.setHeader('Content-Type', 'application/json');

		// Check the file name is valid.
		if (!patches.isValidPath(filename)) {
			res.send(JSON.stringify({
				"status": "error",
				"msg": "A file name may only contain letters, numbers, dashes, underscores, periods, and tildes."
			}));
			return;
		}

		res.send(JSON.stringify({
			"status": "ok",
			"redirect": patch.edit_url + "/editor?file=" + filename
		}));
	});

	// Render a Section
	app.post('/render-body', function(req, res){
		// Use simple-2 to render a preview of the page.

		if (req.body.text == "") {
			res.setHeader('Content-Type', 'application/json');
			res.send(JSON.stringify({
				"status": "ok",
				"html": "<i>The file is now empty and will be deleted from the code.</i>"
			}));
			return;
		}

		// We're passed the current contents of the file. Parse the XML.
		var et = require('elementtree');

		var dom;
		try {
		 dom = et.parse(req.body.text)._root;
		} catch (e) {
			res.writeHead(200, {'Content-Type': 'application/json'});
			res.write(JSON.stringify( { "error": "Invalid XML: " + e } ));
			res.end();
			return;
		}

		// Because of XIncludes that may be present in the file, we may need the
		// contents of other files in order to completely render this page. Get
		// a list of all of the XInclude'd resources.
		var other_resources_hrefs = Array();
		dom.findall('.//ns0:include').forEach(function (elem) {
			if (elem.get("href"))
				other_resources_hrefs.push(elem.get("href"));
		});

		// Asynchronously load all of the binary contents of these resources.
		var patch = patches.Patch.load(req.body.patch);
		async.map(
			other_resources_hrefs,
			function(item, callback) {
				var fn = pathlib.join(pathlib.dirname(req.body.path), item);
				patch.getPathContent(fn, false, function(base_content, patch_content) {
					if (patch_content.length == 0) {
						// Empty content indicates a file that does not exist in the
						// tree in this patch.
						callback("Included file \"" + fn + "\" does not exist.");
						return;
					}

					try {
						var other_dom = et.parse(patch_content)._root;
						callback(null, [fn, other_dom]);
					} catch (e) {
						callback("Invalid XML in included file " + fn + ": " + e);
					}
				})
			},
			function(err, results) {
				if (err) {
					res.writeHead(200, {'Content-Type': 'application/json'});
					res.write(JSON.stringify( { "error": err } ));
					res.end();
					return;
				}

				// turn the list of pairs of (filename, dom) into an Object.
				var other_resources = {};
				results.forEach(function(item) {
					other_resources[item[0]] = item[1];
				});

				// finish the preview and send the response
				finish_preview(req.body.path, dom, other_resources, res);
			});

	});

	// Rename a File, smartly.
	app.post('/rename-patch-file', function(req, res){
		var patch = patches.Patch.load(req.body.patch);
		var path = req.body.path;
		var newpath = req.body.newpath;

		res.setHeader('Content-Type', 'application/json');

		// Check the new file name is valid.
		if (!patches.isValidPath(newpath)) {
			res.send(JSON.stringify({
				"status": "error",
				"msg": "A file name may only contain letters, numbers, dashes, underscores, periods, and tildes."
			}));
			return;
		}

		// Check that nothing exists at the path the file is being renamed to.
		patch.pathExists(newpath, false, function(exists) {
			if (exists) {
				res.send(JSON.stringify({
					"status": "error",
					"msg": "A file already exists with that name."
				}));
			} else {

				// Get the content of the file being renamed.
				patch.getPathContent(path, false, function(dummy, content) {
					// If there is no content at the old path, no file exists there.
					if (content == "") {
						res.send(JSON.stringify({
							"status": "error",
							"msg": "No file exists at " + path + "."
						}));
					}

					// Write it to the new path (synchronously).
					patch.writePathContent(newpath, content);

					// Clear the old path (synchronously).
					patch.writePathContent(path, '');

					// Be smart. Every file (except the root) is x:included
					// from another file. Update the x:includes.
					function update_xinclude_in_parent(path, create, callback) {
						// Where would this file be x:included from?
						var parentfile = get_parent_path(path);

						// Get the raw content of the parent file.
						patch.getPathContent(parentfile, false, function(dummy, content) {
							if (content == "") {
								// Parent does not exist. Nothing to modify.
								console.log("parent has no content", parentfile);
								callback();
								return;
							}

							// Parse the XML.
							var et = require('elementtree');
							var dom;
							try {
								dom = et.parse(content);
							} catch (e) {
								// Parsing failed. Nothing to modify.
								console.log("parent has invalid XML", parentfile, e);
								callback();
								return;
							}

							// Find the x:include for this path. elementtree does not provide
							// a good .parent() function so we'll iterate ourselves.
							var relpath = pathlib.relative(pathlib.dirname(parentfile), path);
							var found = false;
							function findxi(node, parent) {
								if (node.tag == "ns0:include" && node.get("href") == relpath) {
									found = true;
									if (!create) {
										// Delete.
										parent.remove(node)
									}
								} else {
									for (var i = 0; i < node.getchildren().length; i++)
										findxi(node.getchildren()[i], node)
								}

							}
							findxi(dom._root, null);
							if (!found && create) {
								// If an x:include didn't exist, then add one to the end of
								// the document.
								xi = et.SubElement(dom._root, "ns0:include");
								xi.set("href", relpath);
								xi.set("xmlns:ns0", "http://www.w3.org/2001/XInclude");
							}

							// Serialize & save.
							dom = dom.write({'xml_declaration': false, 'indent': 2});
							patch.writePathContent(parentfile, dom);
							callback();
						});
					}

					// Update the parent of the old path.
					update_xinclude_in_parent(path, false, function() {
						// Update the parent of the new path.
						update_xinclude_in_parent(newpath, true, function() {
							// Done.
							res.send(JSON.stringify({
								"status": "ok",
								"redirect": patch.edit_url + "/editor?file=" + newpath
							}));
						})
					})
				});
			}
		});

	});	

	// Merge a Patch with its Parent
	app.post('/patch/:patch/_merge_up', function(req, res){
		var patch = patches.Patch.load(req.params.patch);
		var mgmt = require("./management.js");
		mgmt.merge_up(patch, function(err, base_patch) {
			res.setHeader('Content-Type', 'application/json');
			res.send(JSON.stringify({
				"status": (!err ? "ok" : "error"),
				"msg": ""+err,
				"redirect": base_patch.edit_url
			}));
		});
	});

	// Commit the Workspace!
	app.post('/_commit_workspace', function(req, res){
		repo.commit(
			settings.workspace_directory,
			"committing workspace",
			exports.getUser(req.user).committer_name,
			exports.getUser(req.user).committer_email,
			null, // commit date = current date
			false, // don't sign
			false, // don't amend
			function(error, output) {
				res.setHeader('Content-Type', 'application/json');
				res.send(JSON.stringify({
					"status": "ok",
					"msg": error || output
				}));
		});
	});

	// Review Changes for Publishing
	var review_template = swig.compileFile(__dirname + '/templates/review.html');
	app.get('/review', function(req, res) {
		publish.export_to_audit_log(function(err) {
			if (err) {
				res.setHeader('Content-Type', 'text/plain');
				res.send(err);
				return;
			}
			repo.word_diff(settings.audit_repo_directory, "HEAD^..HEAD", function(diff) {
				res.setHeader('Content-Type', 'text/html');
				res.send(review_template({
					csrf_token: req.csrfToken(), // passed to every template
					error: err,
					diff: diff.split(/\n/).map(function(line) {
						var clz = "diff_unknown";
						if (line.substring(0, 3) == "+++" || line.substring(0, 3) == "---" || line.substring(0, 6) == "index ") {
							clz = "diff_hidden";
						} else if (line.charAt(0) == "+") {
							clz = "diff_add";
							line = line.substring(1);
						} else if (line.charAt(0) == "-") {
							clz = "diff_remove";
							line = line.substring(1);
						} else if (line.charAt(0) == " ") {
							clz = "diff_context";
							line = line.substring(1);
						} else if (line.charAt(0) == "~") {
							clz = "diff_newline";
							line = "";
						} else if (m = /^diff --git a\/(\S*)/.exec(line)) {
							clz = "diff_filename";
							line = m[1];
						}
						return {
							css_class: clz,
							text: line,
						};
					})
				}));
			})
		});
	});
	app.post('/review', function(req, res) {
		if (!/\S/.test(req.body.summary1) || !/\S/.test(req.body.summary2)) {
			// no message, just redirect back.
			res.redirect("/review");
		} else {
			// Revise the top commit with the new log message.
			var message = (req.body.summary1||"") + "\n\n" + (req.body.summary2||"");
			publish.publish(message, function(error, output) {
				res.setHeader('Content-Type', 'text/plain');
				res.send(error || output);
			})
		}
	});

	function get_macro_state(req) {
		if ('patch' in req.body) req.body.patch = patches.Patch.load(req.body.patch);
		var macro_module = require('./macros/' + req.body.macro + '.js');
		return { "module": macro_module };
	}

	// Macros
	app.post('/_macro_get_form', function(req, res) {
		var macro = get_macro_state(req);
		macro.module.get_form(req.body, function(html) {
			res.setHeader('Content-Type', 'application/json');
			res.send(JSON.stringify({
				"status": "ok",
				"title": macro.module.title,
				"html": html
			}));
		});
	});
	app.post('/_macro_execute', function(req, res) {
		var macro = get_macro_state(req);

		res.setHeader('Content-Type', 'application/json');

		var validation_error = macro.module.validate_form(req.body);
		if (validation_error) {
			res.send(JSON.stringify({
				"status": "error",
				"msg": validation_error
			}));
			return;
		}

		macro.module.apply(req.body, function(success, message) {
			res.send(JSON.stringify({
				"status": "ok",
				"macro_success": success,
				"msg": message
			}));
		})
	});
}

function finish_preview(fn, dom, other_resources, res) {
	var render_body = require('../ext/simple-2/render_body.js');
	var body;
	try {
		body = render_body.render_body(fn, dom, null, null, null, null, other_resources);
	} catch (e) {
		res.writeHead(200, {'Content-Type': 'application/json'});
		res.write(JSON.stringify( { "error": "Something is wrong in the code: " + e } ));
		res.end();
		return;
	}

	res.setHeader('Content-Type', 'application/json');
	res.send(JSON.stringify({
		"status": "ok",
		"html": body.rendered
	}));
}

function get_parent_path(path) {
	// The parent of index.xml files are index.xml in the parent
	// directory. The parents of other files are the index.xml in
	// the same directory.
	if (path == "index.xml") return null; // root of DOM
	var parentdir;
	if (pathlib.basename(path) == "index.xml")
		parentdir = pathlib.dirname(pathlib.dirname(path));
	else
		parentdir = pathlib.dirname(path);
	return pathlib.join(parentdir, 'index.xml');
}

function get_macros(macro_type) {
	var glob = require("glob");
	var path = require("path");

	var macro_files = glob.sync("editor/macros/*.js");
	var ret = [];
	macro_files.forEach(function(item) {
		var macro_module = require(item.replace(/^editor\//, './')); // require() is relative to this module
		macro_module.id = path.basename(item).replace(/\.js$/, '');
		if (macro_module.macro_type == macro_type) ret.push(macro_module);
	});
	return ret;
}

