var fs = require("fs");
var glob = require("glob");
var pathlib = require("path");
var clone = require('clone');
var uuid = require('node-uuid');
var async = require('async');

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
	repo.get_repository_head(settings.code_directory, settings.code_branch, function(hash) {
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
				patch: patch,
				depth: 0,
				children: []
			};

			for (var i in patch.children) {
				var child = uuid_map[patch.children[i]];
				child = add_children(child);
				child.base_patch = patch;
				rec.children.push(child);
				if (child.depth + 1 > rec.depth) rec.depth = child.depth+1;
			}
			rec.children.sort(function(a,b) { b.depth-a.depth });
			return rec;
		}
		var root_rec = add_children(root_patch);

		function patch_for_template(patch, base_patch, depth) {
			var moment = require('moment');
			return {
				indent: depth,

				patch: patch,
				id: patch.id,
				uuid: patch.uuid,
				type: patch.type,
				base_id: base_patch ? base_patch.id : null,

				edit_url: patch.edit_url,
				modify_with_new_patch: (patch.type != "root") && (patch.children.length > 0),
				can_merge_up: base_patch != null && base_patch.type == "patch",

				draft: patch.draft,

				effective_date_stamp: patch.effective_date ? moment(patch.effective_date).unix() : '0',
				effective_date_display: patch.effective_date ? moment(patch.effective_date).format("MMMM D, YYYY") : "(Not Set)"
			};
		}

		// Serialize the tree into a timeline by following each patch to its
		// child with the longest depth, which is our best guess as to which
		// path is the primary line of development of the code. Each entry
		// in the timeline is an array of patches, the first of which is the
		// root of a subtree.
		var code_history = [];
		var rec = root_rec;
		var prev_rec_array = null;
		while (rec) {
			var rec_array = [];
			rec_array.push(patch_for_template(rec.patch, rec.base_patch, 0));
			code_history.push(rec_array);

			prev_rec_array = rec_array;

			// Take the first child -- the one with the longest depth -- out of the
			// children array and set it as 'next_rec' so that on the next iteration we
			// place it into the timeline as a top-level entry. If there are no
			// children, set next_rec to null to we are done.
			var next_rec;
			if (rec.children.length > 0) {
				next_rec = rec.children.shift();
			} else {
				next_rec = null;
			}

			// Move any remaining decendants of this patch into rec_array.
			function do_descendants(rec, depth) {
				rec.children.forEach(function(child) {
					rec_array.push(patch_for_template(child.patch, rec.patch, depth));
					do_descendants(child, depth+1);
				});
			}
			do_descendants(rec, 1);

			rec = next_rec;
		}

		code_history.reverse();

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
	patch.effective_date = null;
	patch.draft = true;
	patch.metadata = { };
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

Patch.prototype.getChildren = function(callback) {
	/* Gets the child patches (asynchronously). */
	async.map(
		this.children,
		function(item, callback) { Patch.loadByUUID(item, function(child) { callback(null, child); })  },
		function(err, children) {
			callback(children);
		}
	);
}

Patch.prototype.getAncestors = function(callback) {
	/* Gets all of the base patches recursively. */
	if (this.type == "root") {
		// a root patch has no ancestors
		callback([]);
	} else {
		this.getBase(function(base_patch) {
			base_patch.getAncestors(function(ancestors) {
				ancestors.push(base_patch); // modify in place
				callback(ancestors);
			})
		});
	}
}

Patch.prototype.getAncestorsAndMe = function(callback) {
	var patch = this;
	this.getAncestors(function(ancestors) {
		ancestors.push(patch);
		callback(ancestors);
	})
}

Patch.prototype.getPaths = function(path, recursive, with_deleted_files, callback) {
	/* Get a list of files that exist after this patch is applied in
	   the directory named path (or null for the root path). Only
	   immediate child paths are returned. Callback is called with
	   a single argument that is an array of directory entries. Each
	   entry is an object with properties type ('blob' or 'tree')
	   and name.

	   If with_deleted_files, then we include files deleted by this patch.

	   path must not end in a slash.
	   */

	if (this.type == "root") {
		// Go to the repository to get the files in the indicated path.
		repo.ls(settings.code_directory, this.hash, path, recursive, callback);
	} else {
		// Get the files in the base patch, never including files
		// deleted in the base patch.
		var patch = this;
		this.getBase(function(base) {
			base.getPaths(path, recursive, false, function(entries) {
				// Turn the entries into an object keyed by filename.
				var ret = { };
				entries.forEach(function(item) { ret[item.name] = item });

				// Modify according to any added and removed files in
				// this patch.
				for (var entry in patch.files) {
					// If recurse is false, look at entries that are immediate children of the requested path.
					// Otherwise, look at entries that are a descendant of the path.
					var name = null;
					var type = entry.type;
					if (!recursive) {
						// if it's an immediate child of path, the returned name
						// is the base name of the child path.
						if (pathlib.dirname(entry) == path || (path == null && pathlib.dirname(entry) == '.'))
							name = pathlib.basename(entry);

						// if it's a non-immediate child of path but in a directory that didn't
						// exist in the base, add the immediate directory
						else if (path == null || ((pathlib.dirname(entry)+"/").substring(0, path.length+1) == path+"/")) {
							if (path == null)
								name = entry;
							else
								name = entry.substring(path.length+1); // the relative path
							while (pathlib.dirname(name) != '.') // back off until we get to the top-most directory
								name = pathlib.dirname(name);
							type = 'tree';
						}

					} else if (path == null) {
						// no path and looking recursively, so the path to return is
						// the raw entry path
						name = entry;
					} else {
						// looking recursively at a subdirectory; is this a child path?
						if ((pathlib.dirname(entry)+"/").substring(0, path.length+1) == path+"/")
							name = entry.substring(path.length+1);
					}

					// If name wasn't set, this isn't an entry we are returning.
					if (!name) continue;

					if (patch.files[entry].method == "null" && !with_deleted_files) {
						// This path is deleted, and we're supposed to reflect that in the return value.
						if (name in ret)
							delete ret[name];
					} else {
						ret[name] = {
							type: type,
							name: name
						};
					}

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
		if (!a) return -1;
		if (!b) return 1;
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
		false, /* not recursive */
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
				repo.cat(settings.code_directory, myhash, path, function(blob) { callback(null, blob); } );
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
						fs.readFile(dirname + "/" + patch.files[path].storage, { encoding: "utf8" },
								function(err, data) { if (err) throw err; callback(base_content, data, base); }
							);
						return;
					}
					if (patch.files[path].method == "null") {
						callback(base_content, "", base);
						return;
					}
				}

				// The file is not modified by this patch.
				callback(base_content, base_content, base);
			});
		});
	}
}

exports.isValidPath = function(filename) {
	// Check the path/file name is valid. Check each directory/base name in the path,
	// since slashes have to be excluded from the check.
	var path_parts = filename.split("/");
	for (var i = 0; i < path_parts.length; i++)
		if (exports.disallowed_filename_chars.test(path_parts[i]))
			return false;
	return true;
}

Patch.prototype.writePathContent = function(path, new_content, override_checks) {
	/* Writes to disk the new content for a path modified
	   by this patch. */

	if (!exports.isValidPath(path)) throw "invalid path";
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

		if (!(path in this.files) || this.files[path].method != "raw") {
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
	/* Delete a patch. Cannot be a patch that has children. If the patch
	   has any path modifications, force must be set to true.
	   */

	var patch = this;

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
				// A patch that's not a no-op can't be deleted if the patch has children. A
				// more complex operation would be needed to rebase child content.
				if (patch.children.length > 0)
					callback("A patch cannot be deleted when there are patches applied after it.");
				else
					callback("This patch cannot be deleted while there are modifications in " + results.length + " file(s). Use 'force' to delete this patch.",
						results.length);
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
						// remove this patch from the base patch's list of children
						base_patch.children.splice(base_patch.children.indexOf(patch.uuid), 1);

						// and this patch's children to the base patch's child list
						base_patch.children = base_patch.children.concat(patch.children);

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

function diff_add_ellipses(diff) {
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
	async.map(
		Object.keys(patch.files),
		function(changed_path, callback) {
			patch.getPathContent(changed_path, true, function(base_content, current_content) {
				var jot_seq = require("../ext/jot/jot/sequences");
				var ops = jot_seq.from_diff(base_content, current_content, "words");

				// turn the operations into a list of added/removed/unchanged hunks
				var lastpos = 0;
				var xpos = 0;
				diff = [];
				ops.forEach(function(op) {
					if (op.pos+xpos != lastpos)
						diff.push({ added: false, removed: false, value: base_content.substr(lastpos, op.pos+xpos-lastpos) })
					lastpos = op.pos+xpos + op.old_value.length;
					xpos -= (op.new_value.length - op.old_value.length);

					if (op.old_value.length > 0)
						diff.push({ added: false, removed: true, value: op.old_value })
					if (op.new_value.length > 0)
						diff.push({ added: true, removed: false, value: op.new_value })
				});
				if (lastpos != base_content.length-1)
					diff.push({ added: false, removed: false, value: base_content.substr(lastpos, base_content.length-lastpos) })

				diff = diff_add_ellipses(diff);
				callback(null, { path: changed_path, diff: diff }) // null=no error
			});
		},
		function(err, results) {
			callback(results);
		}
	);
}

exports.export_code = function(callback) {
	// Creates a new branch in the code repository dated today and commits
	// each patch from the beginning onto it. If early patches haven't changed,
	// git is smart enough not to create new commit objects. The common
	// history of branches will be the same commits.
	//
	// Calls callback(err, [gitoutputs]).

	// Get the code history of this patch.
	exports.getTree(function(patch_history) {
		// We get the tree in reverse-chronological order with each record
		// an array containing the main-line patch and any auxiliary children
		// (like we display it). Also we get a dict with various pre-loaded
		// info for display. Just get the patch objects on the main line.
		patch_history.reverse();
		for (var i = 0; i < patch_history.length; i++)
			patch_history[i] = patch_history[i][0].patch;

		// Sanity check.
		if (patch_history[0].type != "root") {
			callback("Invalid initial patch.");
			return;
		}

		// remove the root patch from the history since we never commit it
		var root_patch = patch_history.shift();

		if (patch_history.length == 0) {
			callback("There is nothing to export.");
			return;
		}

		// start from the base patch's commit
		repo.checkout_detached_head(
			settings.code_directory,
			root_patch.hash,
			function(err) {

			if (err) {
				callback(err);
				return;
			}

			// start committing!
			async.mapSeries(
				patch_history,
				function(item, callback) {
					item.commit(null, null, callback)
				},
				function(err, results) {
					if (err) { callback(err); return; }

					// Make a signed tag for the last commit. We don't sign
					// the individual commits because each time we export the
					// hashes will change. Rather, we want to take advantage of
					// the hashes being stable (so long as the patch doesn't change)
					// so that re-exporting over and over won't blow up the repository.
					repo.get_repository_head(settings.code_directory, null, function(hash) {
						var tag_name = "release_" + new Date().toISOString().replace(/[^0-9]/g, "");
						repo.tag(
							settings.code_directory,
							hash,
							tag_name,
							"official code export",
							true,
							settings.committer_name,
							settings.committer_email,
							callback);
					});
				}
			)
		});

	});
}

Patch.prototype.commit = function(changed_paths, message, callback) {
	// Reset the working tree (reset --hard), adds any modified
	// or deleted files (add -A), commits the result (commit -m),
	// and calls callback with (err, hash, commit_output).
	var patch = this;
	if (!patch.effective_date) { callback("Patch " + patch.id + " does not have an effective date set."); return; }

	function write_working_tree_path(path, content, callback) {
		// Writes the content to the working tree path. 
		var mkdirp = require('mkdirp');
		var fn = pathlib.join(settings.code_directory, path);
		mkdirp(pathlib.dirname(fn), function(err) {
			if (err)
				callback(err)
			else
				fs.writeFile(fn, content, callback);
		});
	}

	function delete_working_tree_path(path, callback) {
		var fn = pathlib.join(settings.code_directory, path);
		fs.unlink(fn, function(err) { callback(); }) // ignore error (hmmm...)
	}

	repo.clean_working_tree(settings.code_directory, function() {
		// make the modifications specified by this patch in the working tree of the repository
		async.map(
			changed_paths || Object.keys(patch.files),
			function(changed_path, callback) {
				patch.getPathContent(changed_path, false, function(base_content, current_content) {
					if (current_content != "")
						write_working_tree_path(changed_path, current_content, callback);
					else
						delete_working_tree_path(changed_path, callback);
				});
			},
			function(err, results) {
				if (err) { callback(err); return; }
				repo.commit(
					settings.code_directory,
					message || patch.id + "\n\n" + patch.notes,
					settings.committer_name,
					settings.committer_email,
					new Date(patch.effective_date).toISOString(),
					false, // don't sign because it will change the hash
					function(commit_output) {
						callback(null, commit_output);
					});
			}
		);

	});
}

