var fs = require("fs");
var glob = require("glob");
var path = require("path");
var clone = require('clone');
var uuid = require('node-uuid');
var async = require('async');
var jsdiff = require('diff');

var repo = require("./repository.js");
var settings = require("./settings.js");

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
			return path.basename(path.dirname(item));
		}));
		return;
	}

	// If there are no patches, this is probably the first run.

	// Try to make the workspace directory if it doesn't exist.
	try {
		fs.mkdirSync(settings.workspace_directory)
	} catch (e) {
		// ignore if it exists
		if (e.code != "EEXIST") throw e;
	}

	// Create a "root patch" that represents the state of the
	// code as of what's given in the base code directory.
	repo.get_repository_head(function(hash) {
		new_patch_internal(new Patch({
			"id": "root",
			"type": "root",
			"hash": hash,
		}));
		callback(["root"]);
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
		var root = null;
		for (var i in patches)
			if (patches[i].type == "root")
				root = { obj: patches[i], depth: 0, children: [] };

		// recursively add the children, at each child compute
		// the 'depth' which is the maximum depth of any subtree
		// from the child, and sort the children from greatest
		// depth to least depth.
		function add_children(rec) {
			for (var i in rec.obj.children) {
				var child = { obj: uuid_map[rec.obj.children[i]], depth: 0, children: [] };
				rec.children.push(child);
				add_children(child);
				if (child.depth + 1 > rec.depth) rec.depth = child.depth+1;
			}
			rec.children.sort(function(a,b) { a.depth-b.depth });
		}
		add_children(root);

		// serialize the tree into an array of rows, where each row
		// is an array of patches to display in columns
		var rows = [[root]];
		while (true) {
			var next_row = [];
			var row = rows[rows.length-1];
			row.forEach(function(rec, ri) {
				rec.children.forEach(function(child, ci) {
					if (ri == 0 && row.length == 1 && ci > 0)
						row.push(child);
					else
						next_row.push(child);
				})
			})
			if (next_row.length == 0) break;
			rows.push(next_row);
		}

		rows.reverse();
		callback(rows);
	});
};

function new_patch_internal(patch) {
	// fill in additional data
	patch.uuid = uuid.v4();
	patch.created = new Date();
	patch.files = { }; // the actual changes w/in this patch
	patch.children = [ ]; // UUIDs of children whose base patch is this patch
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
	patch.title = patch_id; // maybe override this later
	patch.edit_url = "/patch/" + patch_id;
	if (patch.type != "root") patch.can_modify = true;

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
		repo.ls(null, path, callback);
	} else {
		// Get the files in the base patch, never including files
		// deleted in the base patch.
		this.getBase(function(base) {
			base.getPaths(path, false, function(entries) {
				// TODO: Modify according to the added and removed files in
				// this patch.
				callback(entries);
			})
		});
	}
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
		repo.cat(null, path, function(blob) { callback(null, blob); } );
	} else {
		var dirname = settings.workspace_directory + "/" + this.id;

		if ((path in this.files) && this.files[path].method == "raw" && !with_base_content) {
			// If the entire new content is stored raw, and the caller doesn't need
			// the base content, just load the file and return.
			fs.readFile(dirname + "/" + this.files[path].storage, { encoding: "utf8" }, function(err, data) { if (err) throw err; callback(null, data); });
			return;
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
				}

				// The file is not modified by this patch.
				callback(base_content, base_content);
			});
		});
	}
}

Patch.prototype.writePathContent = function(path, new_content) {
	/* Writes to disk the new content for a path modified
	   by this patch. */

  	var needs_save = false;

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
	var disallowed_chars = /[^A-Za-z0-9\-_]/;
	if (disallowed_chars.test(new_id)) {
		callback("Patch names may only contain letters, numbers, dashes, and underscores. Spaces are not allowed.")
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

Patch.prototype.delete = function(callback) {
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
	async.parallel(
		// map the file paths modified by this patch to a function that
		// async can call to process that file.
		Object.keys(patch.files).map(function(path) {
			return function(callback) {
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
			};
		}),
		function(err, results) {
			// remove the nulls from the results which came from unmodified paths,
			// keeping just the strings which are the paths of modified files.
			results = results.filter(function(item) { return item != null; });
			if (results.length > 0) {
				callback("This patch cannot be deleted while there are modifications in " + results.join(", ") + ".");
				return;
			}

			// There are no modified files, so this patch may be deleted.

			// In order to delete a patch, any patch whose base is this patch must be revised
			// so that its base is the base of this path. Since the reference to the child
			// patches is by UUID, we can only load them asynchronously, so we have to use
			// async.parellel again.
			async.parallel(
				// map the children UUIDs to a function that async.parallel can call to
				// process that UUID.
				patch.children.map(function(child_uuid) {
					return function(callback) {
						// the function asyncronously loads the child patch by its UUID
						Patch.loadByUUID(child_uuid, function(child_patch) {
							// and then updates the child...
							child_patch.base = patch.base;
							child_patch.save();

							// and finally signals that this work is done.
							callback();
						});
					};
				}).concat([

				// also if this patch has a base, update the base to remove the reference to
				// this patch as a child.
				function(callback) {
					if (patch.type != "patch") {
						// root patches don't have a base
						callback();
						return;
					}
					patch.getBase(function(base_patch) {
						base_patch.children = base_patch.children.filter(function(child_uuid) { child_uuid != patch.uuid });
						base_patch.save();
						callback();
					});
				}

				]),
				function (err, results) {
					// At this point the patch is safe to delete.

					// Delete the storage of modified paths synchronously.
					Object.keys(patch.files).forEach(function(path) {
						if (patch.files[path].method == "raw") {
							fs.unlinkSync(settings.workspace_directory + "/" + patch.id + "/" + patch.files[path].storage);
						}
					});

					// Delete the index file synchronously.
					fs.unlinkSync(settings.workspace_directory + "/" + patch.id + "/" + "index.json");

					// Remove the directory.
					fs.rmdirSync(settings.workspace_directory + "/" + patch.id);

					// Signal success.
					callback(null);
				}
			);
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
