var fs = require("fs");
var glob = require("glob");
var pathlib = require("path");
var clone = require('clone');
var uuid = require('node-uuid');
var async = require('async');
var jsdiff = require('diff');

var repo = require("./repository.js");
var settings = require("./settings.js");

exports.disallowed_filename_chars = /[^A-Za-z0-9\-_\.\~]/;

/*
 * Class declaration for a Patch instance.
 * This should only be called by internal functions in this
 * module. Pass an Object of initial properties to set on the Patch.
 */
exports.Patch = function(initial_properties) {
	// copy initial properties from initial_properties
	for (var key in initial_properties)
		this[key] = initial_properties[key];
}

// alias for this module
Patch = exports.Patch;

/*
 * Methods.
 */

function getAllPatchIds(callback) {
	/* Scan the workspace_directory for the IDs of all patches
	   and return them asynchronously: callback(array_of_patch_ids). */

	// Use glob to find all of the patch index.json files,
	// and then return the list of directory names.
	var patch_index_files = glob.sync(settings.workspace_directory + "/*/index.json");
	if (patch_index_files.length > 0) {
		callback(patch_index_files.map(function(item) {
			return pathlib.basename(pathlib.dirname(item));
		}));
		return;
	}

	// If there are no patches, this must be the first run.

	// Try to make the workspace directory if it doesn't exist.
	try {
		fs.mkdirSync(settings.workspace_directory)
	} catch (e) {
		// ignore if it exists
		if (e.code != "EEXIST") throw e;
	}

	// Create a root patch based on the code repository.
	createRootPatch(function(patch) { callback([patch.id]); });
}

function createRootPatch(callback) {
	// Create a "root patch" that represents the state of the
	// code as of what's given in the base code directory.
	repo.get_repository_head(function(hash) {
		var p = new_patch_internal(new Patch({
			"id": "root-" + hash.substring(0, 6),
			"type": "root",
			"hash": hash,
			"notes": "The code as committed in " + hash + "."
		}));
		callback(p);
	});
	
}

exports.getTree = function(callback) {
	/* Computes a data structure for showing all of
	   the patches as a tree. */
	getAllPatchIds(function(patch_ids) {
		// load up every Patch instance
		var patches = patch_ids.map(function(item) { return Patch.load(item); });

		// make a UUID map
		var uuid_map = { };
		for (var i in patches)
			uuid_map[patches[i].uuid] = patches[i];

		// find the root patch
		var root_patch = null;
		for (var i in patches)
			if (patches[i].type == "root")
				root_patch = patches[i];

		// recursively add the children, at each child compute
		// the 'depth' which is the maximum depth of any subtree
		// from the child, and sort the children from greatest
		// depth to least depth so that we know which child of
		// a patch is most likely the main line and which is
		// a side patch waiting to be merged.
		function add_children(patch) {
			var rec = {
				id: patch.id,
				uuid: patch.uuid,
				type: patch.type,
				edit_url: patch.edit_url,
				modify_with_new_patch: (patch.type != "root") && (patch.children.length > 0),
				can_merge_up: false, 
				depth: 0,
				children: []
			};
			for (var i in patch.children) {
				var child = uuid_map[patch.children[i]];
				child = add_children(child);
				child.base_id = rec.id;
				child.can_merge_up = (patch.type != "root"); // if base isn't root, and a child is never a root
				rec.children.push(child);
				if (child.depth + 1 > rec.depth) rec.depth = child.depth+1;
			}
			rec.children.sort(function(a,b) { b.depth-a.depth });
			return rec;
		}
		var root_rec = add_children(root_patch);

		// pull out the first child of each patch to make a list, and have the
		// remaining children of each patch be children.
		function serialize(rec, ret, indent) {
			var children = rec.children;
			delete rec.children;
			rec.indent = (indent||0);

			// do the first child first, to make this in reverse chronological order
			// at the top level
			if (rec.indent == 0 && children.length > 0)
				serialize(children.shift(), ret, indent);

			// then the patch itself
			ret.push(rec);

			// then any other child, which is shown as a sub-patch within the
			// main patch 
			children.forEach(function(item) {
				serialize(item, ret, (indent||0)+1);
			});
		}
		var code_history = [];
		serialize(root_rec, code_history);

		callback(code_history);
	});
};

function new_patch_internal(patch) {
	// fill in additional data
	patch.uuid = uuid.v4();
	patch.created = new Date();
	patch.files = { }; // the actual changes w/in this patch
	patch.children = [ ]; // UUIDs of children whose base patch is this patch
	patch.notes = patch.notes || "";
	patch.save();
	return Patch.load(patch.id);
}

Patch.prototype.createChild = function() {
	/* Creates a new Patch that continues from this patch, its base_patch.
	   Returns the new Patch instance immediately. */

	// Get an ID that is not in use.
	var new_id;
	var ctr = 0;
	while (true) {
		new_id = "NewPatch";
		if (ctr > 0) new_id += "_" + ctr;
		if (!fs.existsSync(settings.workspace_directory + "/" + new_id)) break;
		ctr++;
	}

	// Create the new patch.
	var patch = new_patch_internal(new Patch({
		"id": new_id,
		"type": "patch",
		"base": this.uuid,
	}));

	// Update the base to note that this is a child.
	// Unfortunately this creates redundant information, but it allows us to avoid
	// scanning the whole workspace directory to find the children of each patch.
	this.children.push(patch.uuid);
	this.save();

	return patch;
}

Patch.prototype.save = function() {
	/* Writes the Patch metadata to disk. */

	// clone before modifying
	patch_obj = clone(this);

	// remove the 'id' from the object before writing so it is not redunctant with the directory name
	var patch_name = patch_obj.id;
	delete patch_obj.id;

	// remove other dynamically added fields
	if ("edit_url" in patch_obj) delete patch_obj.edit_url;
	if ("can_modify" in patch_obj) delete patch_obj.can_modify;
	if ("created_formatted" in patch_obj) delete patch_obj.created_formatted;

	// prepare fields for serialization
	patch_obj.created = patch_obj.created.toISOString();

	// write file
	var dirname = settings.workspace_directory + "/" + patch_name;
	if (!fs.existsSync(dirname)) fs.mkdirSync(dirname);
	fs.writeFileSync(dirname + "/index.json", JSON.stringify(patch_obj, null, 4));

	// update our cache
	patch_id_cache[patch_obj.uuid] = patch_obj.id;
}

Patch.load = function(patch_id) {
	/* Loads a Patch instance by the Patch's ID (i.e. the directory name). */

	var patch_data = JSON.parse(fs.readFileSync(settings.workspace_directory + "/" + patch_id + "/index.json"));
	var patch = new Patch(patch_data);

	// fill in some things
	patch.id = patch_id;
	patch.edit_url = "/patch/" + patch_id;
	if (patch.type != "root" && patch.children == 0) patch.can_modify = true;

	// parse some fields
	patch.created = new Date(patch.created);
	patch.created_formatted = patch.created.toLocaleString();

	return patch;
}

patch_id_cache = { };
Patch.loadByUUID = function(uuid, callback) {
	/* Asynchronously load a patch given its UUID.
	   Returns the Patch instance via the callback: callback(patch_instance).
	   */

	// Try to load the patch named in the cache. Double check that it
	// has the right UUID stored. If not, ignore what the cache says
	// and scan the whole directory to find the cache.
	if (uuid in patch_id_cache) {
		try {
			var p = Patch.load(patch_id_cache[uuid]);
			if (p.uuid == uuid) {
				callback(p);
				return;
			}
		} catch (e) {
			// just pass through
		}
		delete patch_id_cache[uuid];
	}

	getAllPatchIds(function(entries) {
		entries.some(function(entry){
			var p = Patch.load(entry);
			patch_id_cache[p.uuid] = p.id;
			if (p.uuid == uuid) {
				callback(p);
				return true; // end loop
			}
			return false;
		});
	});
}

Patch.prototype.getBase = function(callback) {
	/* Gets the base patch (asynchronously). */
	Patch.loadByUUID(this.base, callback);
}

Patch.prototype.getPaths = function(path, with_deleted_files, callback) {
	/* Get a list of files that exist after this patch is applied in
	   the directory named path (or null for the root path). Only
	   immediate child paths are returned.

	   If with_deleted_files, then we include files deleted by this patch.
	   */

	if (this.type == "root") {
		// Go to the repository to get the files in the indicated path.
		repo.ls(this.hash, path, callback);
	} else {
		// Get the files in the base patch, never including files
		// deleted in the base patch.
		var patch = this;
		this.getBase(function(base) {
			base.getPaths(path, false, function(entries) {
				// Turn the entries into an object keyed by filename.
				var ret = { };
				entries.forEach(function(item) { ret[item.name] = item });

				// Modify according to any added and removed files in
				// this patch.
				for (var entry in patch.files) {
					// Just look at entries that are immediate children of the requested path.
					if (pathlib.dirname(entry) == path || (path == null && pathlib.dirname(entry) == '.')) {
						var name = pathlib.basename(entry);
						if (patch.files[entry].method == "null" && !with_deleted_files) {
							// This path is deleted, and we're supposed to reflect that in the return value.
							if (name in ret)
								delete ret[name];
						} else {
							ret[name] = {
								type: 'blob',
								name: name
							};
						}
					}

					// TODO: Or if there is a path (except deletions) that are in a subpath of
					// the requested path, add in new directories.

					// TOOD: How would deleted directories be reflected?
				}

				// Turn the object back into an array.
				ret = Object.keys(ret).map(function(key) { return ret[key] });

				callback(ret);
			})
		});
	}
}

exports.sort_paths = function(path_list) {
	function cmp(a, b) {
		var x = parseInt(a) - parseInt(b);
		if (x) return x; // not NaN (strings arent ints) and not zero
		return a.localeCompare(b);
	}

	path_list.sort(function(a, b) {
		// sort quasi-lexicographically, but segmented by
		// dashes and with integer-looking parts sorted
		// as integers
		if (a.name == "index.xml") return -1;
		if (b.name == "index.xml") return 1;
		var a = a.name.split("-");
		var b = b.name.split("-");
		while (a.length || b.length) {
			var c = cmp(a.shift(), b.shift());
			if (c != 0) return c;
		}
		return 0;
	});
}

Patch.prototype.pathExists = function(path, with_deleted_files, callback) {
	/* Checks if a path is present in this patch. If with_deleted_files, returns
	   true even if the path is deleted in this patch. */

	// First check if the path is modified in this patch. If it has content,
	// it exists. If it is being deleted, then it exists just when the caller
	// wants to include deleted files.
	if (path in this.files) {
		if (this.files[path].method == "raw")
			callback(true);
		else if (this.files[path].method == "null")
			callback(with_deleted_files);
		else
			throw "unhandled case"
		return;
	}

	// The path isn't modified in this patch but it may or may not still exist.
	// Don't look at the base patch in case this is the root patch. Just look
	// at the paths that exist in this patch.
	var up_path = pathlib.dirname(path);
	if (up_path == ".") up_path = null;
	var fn = pathlib.basename(path);
	this.getPaths(
		up_path,
		true, /* include files deleted in this patch, though we would have handled that case above */
		function(entries) {
			for (var i = 0; i < entries.length; i++) {
				if (entries[i].name == fn) {
					callback(true);
					return;
				}
			}
			callback(false);
		});
}

Patch.prototype.getPathContent = function(path, with_base_content, callback) {
	/* Gets the content of a path after this patch is applied, and if
	   with_base_content is true then we also provide the base content,
	   i.e. the content prior to this patch.

	   The content is returned asynchronously: callback(base_content, new_content).
	   */

	if (this.type == "root") {
		// Go to the repository to get the files in the indicated path.
		if (with_base_content) throw "Cannot set with_base_content=true on a root patch.";

		// When inserting new files, we end up looking at patches from when before
		// the file is created to get base content. Let this happen but just send
		// an empty string. If we don't check first, git returns a non-zero exit
		// status trying to cat the contents and an exception is thrown.
		var myhash = this.hash;
		this.pathExists(path, false, function(exists) {
			if (!exists)
				callback(null, "");
			else
				repo.cat(myhash, path, function(blob) { callback(null, blob); } );
		});
	} else {
		var dirname = settings.workspace_directory + "/" + this.id;

		if ((path in this.files) && !with_base_content) {
			// If the entire new content is stored raw, and the caller doesn't need
			// the base content, just load the file and return.
			if (this.files[path].method == "raw") {
				fs.readFile(dirname + "/" + this.files[path].storage, { encoding: "utf8" }, function(err, data) { if (err) throw err; callback(null, data); });
				return;
			}

			// Similarly, if the file was deleted, return empty content.
			if (this.files[path].method == "null") {
				callback(null, "");
				return;
			}
		}

		// Ask the base revision for its current content. We don't need *its* base.
		var patch = this;
		this.getBase(function(base) {
			base.getPathContent(path, false, function(dummy, base_content) {
				if (path in patch.files) {
					// This file is modified by the patch.
					if (patch.files[path].method == "raw") {
						fs.readFile(dirname + "/" + patch.files[path].storage, { encoding: "utf8" }, function(err, data) { if (err) throw err; callback(base_content, data); });
						return;
					}
					if (patch.files[path].method == "null") {
						callback(base_content, "");
						return;
					}
				}

				// The file is not modified by this patch.
				callback(base_content, base_content);
			});
		});
	}
}

Patch.prototype.writePathContent = function(path, new_content, override_checks) {
	/* Writes to disk the new content for a path modified
	   by this patch. */

	if (!override_checks && (this.type == "root" || this.children.length > 0)) throw "Cannot modify the content of a root patch or a patch that has children!"

	var needs_save = false;

	if (new_content == "") {
		// Empty content flags a deleted file.
		// Save with the "null" storage type. Flagging the content as null
		// here makes it easy to check whether the path is deleted elsewhere.

		if ((path in this.files) && this.files[path].method == "raw") {
			// Delete the storage from disk.
			fs.unlinkSync(settings.workspace_directory + "/" + this.id + "/" + this.files[path].storage);
		}

		this.files[path] = {
			method: "null"
		};
		needs_save = true;

	} else {
		// Save the content with the "raw" method, which means we dump the
		// contents of the file into a file.

		if (!(path in this.files)) {
			// How should we store the changes on disk?
			this.files[path] = {
				storage: path.replace(/\//g, "_"),
				method: "raw"
			};
			needs_save = true;
		}

		fs.writeFileSync(
			settings.workspace_directory + "/" + this.id + "/" + this.files[path].storage,
			new_content);
	}

	if (needs_save)
		this.save();
}

Patch.prototype.rename = function(new_id, callback) {
	/* Rename the patch, asynchronously. The patch object should
	   not be used after a call to this method.
	   On success, the callback is called with null as the first
	   argument (no error) and a new Patch instance in the second
	   argument.
	   On failure, the callback is called with an error message in
	   the first argument. */

	// If new_id is already the ID of the patch, pretend like
	// we did the rename.
	if (this.id == new_id) {
		callback(null, this);
		return;
	}

	// Attempt to rename the directory on disk. Since patches reference
	// other patches by their UUID, which is not changed by this operation,
	// we don't have to worry about broken references.

	// First test that this is a valid name.
	if (exports.disallowed_filename_chars.test(new_id)) {
		callback("Patch names may only contain letters, numbers, dashes, underscores, periods, and tildes. Spaces are not allowed.")
		return;
	}

	// Check that no patch exists with that name.
	if (fs.existsSync(settings.workspace_directory + "/" + new_id)) {
		callback("A patch with that name already exists.")
		return;
	}

	// Attempt rename.
	fs.rename(
		settings.workspace_directory + "/" + this.id,
		settings.workspace_directory + "/" + new_id,
		function(err) {
			if (!err)
				callback(null, Patch.load(new_id));
			else
				callback(""+err);
		});
}

Patch.prototype.delete = function(callback, force) {
	/* Delete a patch, but only if the patch doesn't actually make any changes.

	   If the patch has child patches, revise their base to be the base of this patch.
	   */

	var patch = this;

	// A root patch can't be deleted if there are patches that referecne it because
	// we can't re-assign their base patch to nothing.
	if (this.children.length > 0 && this.type == "root") {
		callback("A root patch cannot be deleted when there are patches applied after it.");
		return;
	}

	// Is this patch a no-op? In parallel, look at each modified file.
	// See if the new contents differ from the old contents. Doing
	// this asynchronously unfortunately makes this very hard to read.
	async.map(
		Object.keys(patch.files),
		function(path, callback) {
			// if 'force', don't check if the path has modifications
			if (force) {
				callback(null, null);
				return;
			}

			// get the base and revised content of the modified file
			patch.getPathContent(path, true,
				function(base_content, new_content) {
					// check if the content has been modified and call the async.parallel
					// callback method with null for the error argument and...
					if (base_content == new_content)
						callback(null, null); // "null" to signal no actual change in this file
					else
						callback(null, path); // the changed path to signal a path that has modified content
				});
		},
		function(err, results) {
			// remove the nulls from the results which came from unmodified paths,
			// keeping just the strings which are the paths of modified files.
			results = results.filter(function(item) { return item != null; });
			if (results.length > 0) {
				callback("This patch cannot be deleted while there are modifications in " + results.join(", ") + ".");
				return;
			}

			// There are no modified files, or force is true, so this patch may be deleted.

			async.parallel({
				update_children: function(callback) {
					// In order to delete a patch, any patch whose base is this patch must be revised
					// so that its base is the base of this path. Since the reference to the child
					// patches is by UUID, we can only load them asynchronously, so we have to use
					// async.parellel again.
					async.map(
						patch.children,
						function(child_uuid, callback) {
							// the function asyncronously loads the child patch by its UUID
							Patch.loadByUUID(child_uuid, function(child_patch) {
								// and then updates the child...
								child_patch.base = patch.base;
								child_patch.save();

								// and finally signal that this work is done.
								callback();
							});
						},
						callback // no error is possible
					);
				},

				update_base: function(callback) {
					// if this patch has a base, update the base to remove the reference to
					// this patch as a child and add in this patch's children.
					if (patch.type == "root") {
						// root patches don't have a base
						callback();
						return;
					}
					patch.getBase(function(base_patch) {
						base_patch.children =
							base_patch.children.filter(function(child_uuid) { return child_uuid != patch.uuid })
							.concat(patch.children);
						base_patch.save();
						callback();
					});
				},

				delete_files: function(callback) {
					// Some paths may not have modifications but may still have a file written
					// to disk with unchanged data. Or we may have specified force. So any
					// storage for this file must be deleted, which we do now synchronously.
					Object.keys(patch.files).forEach(function(path) {
						if (patch.files[path].method == "raw")
							fs.unlinkSync(settings.workspace_directory + "/" + patch.id + "/" + patch.files[path].storage);
					});

					// Delete the index file synchronously.
					fs.unlinkSync(settings.workspace_directory + "/" + patch.id + "/" + "index.json");

					// Remove the directory.
					fs.rmdirSync(settings.workspace_directory + "/" + patch.id);

					// Signal success.
					callback();					
				}

			},
			function(err, result) {
				if (err) err = "Really bad error while updating patches: " + err + " Workspace may be corrupted.";
				callback(err);
			});
		}
	);

}

function simplify_diff(diff) {
	// Only include hunks that represent unchanged content
	// that ocurr on the same line as changed content.
	// Between lines, add an ellipsis.
	var new_diff = [];
	var this_line = [];
	var wants_more = false;
	var added_ellipsis = false;
	diff.forEach(function(hunk) {
		if (hunk.added || hunk.removed) {
			// append all of this_line to the end of new_diff, then clear it
			new_diff = new_diff.concat(this_line);
			this_line = [];

			// and append this changed hunk
			new_diff.push(hunk);

			// we want to continue adding hunks to the end of the line
			// if this change doesn't end with a newline
			wants_more = (hunk.value.charAt(new_diff.length-1) != "\n");
			added_ellipsis = false;
		} else {
			// if we want more to the end of the line, add the part
			// of this hunk to its first newline character.
			var n1 = hunk.value.indexOf("\n");
			if (wants_more) {
				if (n1 >= 0) wants_more = false; // the end of line is in here
				n1 = (n1 >= 0 ? (n1+1) : hunk.value.length);
				var h = hunk.value.substring(0, n1);
				hunk.value = hunk.value.substring(n1);
				new_diff.push({ value: h });
				added_ellipsis = false;
			}

			var n2 = hunk.value.lastIndexOf("\n");
			if (n2 == -1) {
				this_line.push({ value: hunk.value });
			} else {
				// if we're about to kill a previously buffered line,
				// or we're dropping content in this hunk before the
				// newline, and we didn't just add an ellipsis, and
				// if we're not adding an ellipsis at the very beginning...
				if ((this_line.length > 0 || n2 > 0) && !added_ellipsis && new_diff.length > 0) {
					added_ellipsis = true;
					new_diff.push({ value: " · · ·\n", ellipsis: true });
				}
				this_line = [];
				this_line.push({ value: hunk.value.substring(n2+1) });
			}
		}
	});

	// remove an ellipsis at the end
	if (new_diff.length > 0 && new_diff[new_diff.length-1].ellipsis)
		new_diff.pop();

	return new_diff;
}

Patch.prototype.getDiff = function(callback) {
	// Computes a list of objects that have 'path' and 'diff'
	// attributes representing the changes made by this patch.
	var patch = this;
	async.parallel(
		// map the changed paths to functions that compute
		// the unified diff on the changed path
		Object.keys(patch.files).map(function(changed_path) {
			return function(callback2) {
				patch.getPathContent(changed_path, true, function(base_content, current_content) {
					var diff = jsdiff.diffWords(base_content, current_content);
					diff = simplify_diff(diff);
					callback2(null, { path: changed_path, diff: diff }) // null=no error
				});
			};
		}),

		function(err, results) {
			callback(results);
		}
	);	
}

Patch.prototype.get_jot_operations = function(callback) {
	/* Computes an array of JOT operations object that represent the changes made by this patch. 
	   Passes the array to the callback. */

	var jot_objects = require('../ext/jot/jot/objects.js');
	var jot_sequences = require('../ext/jot/jot/sequences.js');
	var jot_values = require('../ext/jot/jot/values.js');
	var jot_meta = require('../ext/jot/jot/meta.js');

	// map each changed file to a JOT operation
	var patch = this;
	async.map(
		Object.keys(patch.files),
		function(changed_path, callback) {
			patch.getPathContent(changed_path, true, function(base_content, current_content) {
				callback(
					null, // no error
					jot_objects.APPLY(
						changed_path,
						jot_meta.COMPOSITION(
							// use Google Diff Match Patch to create an array of operations
							// that represent the changes made to this path
							jot_sequences.from_string_rep(
								jot_values.REP(
									base_content,
									current_content
									)
							)
						)
					)
				);
			});
		},
		function(err, result) {
			var ret = [];
			for (var i in result)
				ret = ret.concat(result[i]);
			callback(ret)
		}
	);	
};

Patch.prototype.compute_rebase = function(jot_op, callback) {
	// Computes the rebase of the *subtree* headed by this patch
	// against jot_op, which is a JOT operation object representing
	// the changes made in the patch we are rebasing against.

	var patch = this;
	this.get_jot_operations(function(this_as_jot_op) {
		// compute the rebase of this patch
		var jot_base = require('../ext/jot/jot/base.js');
		var result = jot_base.rebase_array(jot_op, this_as_jot_op);
		var inverse_result = jot_base.rebase_array(this_as_jot_op, jot_op);
		if (!result || !inverse_result) {
			callback("The changes conflict with the changes in patch " + patch.id + ".");
			return;
		}

		async.map(
			patch.children,
			function(child_uuid, callback) {
				Patch.loadByUUID(child_uuid, function(child_patch) {
					child_patch.compute_rebase(inverse_result, function(err, result) {
						if (err) {
							callback(err);
							return;
						}
						callback(null, [child_uuid, result])
					});
				})
			},
			function(err, child_results) {
				if (err) {
					callback(err);
					return;
				}

				callback(
					null, // no error
					{
						me: result,
						children: child_results
					});
			}
		);
	});
}

Patch.prototype.save_rebase = function(rebase_data, callback) {
	// Apply

	var jot_base = require('../ext/jot/jot/base.js');

	var patch = this;

	// rebase_data.me contains an array of JOT objects APPLY operations,
	// each specifying the path of a modified file.
	async.map(
		rebase_data.me,
		function(applyop, callback) {
			// This JOT operation has a key named 'key' which has the
			// path of a modified file, and another key named 'op' which
			// has a COMPOSITION operation which will transform the file
			// contents.
			var changed_path = applyop.key;
			patch.getPathContent(changed_path, true, function(base_content) {
				var rebased_content = jot_base.apply(applyop.op, base_content);
				patch.writePathContent(changed_path, rebased_content, true); // 'true' overrides sanity checks, since usually we are not allowed to write to patches with children
				callback(); // no errror & nothing to return
			});
		},
		function() {
			// no error or results are possible

			// now apply to the children
			async.map(
				rebase_data.children,
				function(child_info, callback) {
					var child_uuid = child_info[0];
					var child_rebase_data = child_info[1];
					Patch.loadByUUID(child_uuid, function(child_patch) {
						child_patch.save_rebase(child_rebase_data, callback);
					})
				},
				function() {
					callback(); // done, no error & nothing to return
				}
			);
		}
	);
}

Patch.prototype.merge_up = function(callback) {
	/* Merges a patch with its parent, rebasing any other children of the parent. 
	   If this patch has children, the children's base is chnaged to be this
	   patch's base. */

	if (this.type == "root") {
		callback("Cannot merge up a root patch.");
		return;
	}

	var patch = this;

	// First turn this patch into a JOT operation.
	patch.get_jot_operations(function(patch_as_jot_op) {
		// Now attempt to rebase each sibling tree in parallel.
		patch.getBase(function(base_patch) {
			// Can't merge into the root patch either.
			if (base_patch.type == "root") {
				callback("Cannot merge into a root patch.");
				return;
			}

			// get the other children of base_patch
			var sibling_uuids = base_patch.children.filter(function(item) { return item != patch.uuid });

			// compute the rebase of each sibling
			async.map(
				sibling_uuids,
				function(uuid, callback) {
					Patch.loadByUUID(uuid, function(sibling_patch) {
						sibling_patch.compute_rebase(patch_as_jot_op, callback)
					})
				},
				function(err, sibling_rebase_data) {
					if (err) {
						callback(err);
						return;
					}

					// Now that we know the rebase was successful, we can apply it.

					// for each modified path in this patch, save the new content
					// as the contents of the path in the base patch
					async.map(
						Object.keys(patch.files),
						function(changed_path, callback) {
							patch.getPathContent(changed_path, false, function(base_content, current_content) {
								base_patch.writePathContent(changed_path, current_content, true); // 'true' overrides sanity checks, since usually we are not allowed to write to patches with children
								callback(); // no errror & nothing to return
							});
						},
						function() {
							// no error is possible

							// Delete the patch, with force=true (it's the argument after the callback)
							// so that the method skips the check if any paths were modified. Since the
							// base patch has been modified in place, this patch's state is already
							// inconsistent anyway. Deleting also has the effect of re-setting the patch's
							// children's bases to be this patch's base rather than this patch itself,
							// which is good. But note how this creates new siblings.
							patch.delete(function(err) {
								if (err) {
									callback("Really bad error while deleting the patch: " + err + " Workspace is possibly corrupted.");
									return;
								}

								// Now that the base patch has been updated, apply the rebased operations
								// computed above to update the patch content of the siblings. Use the same
								// list of siblings from above a) because it's in the same order as
								// sibling_rebase_data, and b) after patch.delete() the patch may have
								// new siblings.
								async.map(
									Object.keys(sibling_uuids), // => array indexes
									function(i, callback) {
										Patch.loadByUUID(sibling_uuids[i], function(sibling_patch) {
											sibling_patch.save_rebase(sibling_rebase_data[i], callback);
										})								
									},
									function(err) {
										if (err) err = "Really bad error while writing rebased patches: " + err + " Workspace is possibly corrupted.";
										callback(err);
									}
								);
							}, true); // 'true' is the force callback to delete()
						}
					);
				}
			);
		});
	});

}
