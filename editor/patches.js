var fs = require("fs");
var glob = require("glob");
var path = require("path");
var clone = require('clone');
var uuid = require('node-uuid');
var async = require('async');

var repo = require("./repository.js");
var settings = require("./settings.js");

exports.get_patch_tree = function(callback) {
	get_patch_filenames(function(file_list) {
		callback(file_list.map(function(item) {
			return exports.load_patch(item);
		}));
	});
};

function get_patch_filenames(callback) {
	// Scan the workspace_directory for patches and assemble a tree.
	try {
		fs.mkdirSync(settings.workspace_directory)
	} catch (e) {
		// ignore if it exists
		if (e.code != "EEXIST") throw e;
	}

	var patch_index_files = glob.sync(settings.workspace_directory + "/*/index.json");

	if (patch_index_files.length > 0) {
		callback(patch_index_files.map(function(item) {
			return path.basename(path.dirname(item));
		}));
		return;
	}

	// On the first run, create a "root patch" that represents the state of the
	// code as of what's given in the base code directory.
	repo.get_repository_head(function(hash) {
		create_patch_internal(
		{
			"id": "root",
			"type": "root",
			"hash": hash,
		});
		callback(["root"]);
	});
	
}

function create_patch_internal(patch) {
	// fill in additional data
	patch.uuid = uuid.v4();
	patch.created = new Date();
	patch.files = { }; // the actual changes w/in this patch
	patch.children = [ ]; // UUIDs of children whose base patch is this patch
	write_patch(patch);
	return exports.load_patch(patch.id);
}

exports.create_patch_from = function(base_patch) {
	// Get an ID that is not in use.
	var new_id;
	var ctr = 0;
	while (true) {
		new_id = "NewPatch";
		if (ctr > 0) new_id += "_" + ctr;
		if (!fs.existsSync(settings.workspace_directory + "/" + new_id)) break;
		ctr++;
	}

	// Update the base to note that this is a child.
	// Unfortunately this creates redundant information, but it allows us to avoid
	// scanning the whole workspace directory to find the children of each patch.
	base_patch.children.push(new_id);
	write_patch(base_patch);

	// Create the new patch.
	var patch = {
		"id": new_id,
		"type": "patch",
		"base": base_patch.uuid,
	}; 
	return create_patch_internal(patch);
}

function write_patch(patch_obj) {
	// clone before modifying
	patch_obj = clone(patch_obj);

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

exports.load_patch = function(patch_name) {
	var patch = JSON.parse(fs.readFileSync(settings.workspace_directory + "/" + patch_name + "/index.json"));

	// fill in some things
	patch.id = patch_name;
	patch.title = patch_name; // maybe override this later
	patch.edit_url = "/patch/" + patch_name;
	if (patch.type != "root") patch.can_modify = true;

	// parse some fields
	patch.created = new Date(patch.created);
	patch.created_formatted = patch.created.toLocaleString();

	return patch;
}

patch_id_cache = { };
function load_patch_from_uuid(uuid, callback) {
	// Try to load the patch named in the cache. Double check that it
	// has the right UUID stored. If not, ignore what the cache says
	// and scan the whole directory to find the cache.
	if (uuid in patch_id_cache) {
		try {
			var p = exports.load_patch(patch_id_cache[uuid]);
			if (p.uuid == uuid) {
				callback(p);
				return;
			}
		} catch (e) {
			// just pass through
		}
		delete patch_id_cache[uuid];
	}

	get_patch_filenames(function(entries) {
		entries.some(function(entry){
			var p = exports.load_patch(entry);
			if (p.uuid == uuid) {
				patch_id_cache[uuid] = p.id;
				callback(p);
				return true; // end loop
			}
			return false;
		});
	});
}

exports.get_patch_files = function(patch, path, callback) {
	if (patch.type == "root") {
		// Go to the repository to get the files in the indicated path.
		repo.ls(null, path, callback);
	} else {
		// Get the files in the base path.
		load_patch_from_uuid(patch.base, function(base) {
			exports.get_patch_files(base, path, function(entries) {
				// And modify according to the added and removed files in this patch.
				// TODO.
				callback(entries);
			})
		})
	}
}

exports.get_patch_file_content = function(patch, path, with_base_content, callback) {
	if (patch.type == "root") {
		// Go to the repository to get the files in the indicated path.
		if (with_base_content) throw "Cannot set with_base_content=true on a root patch.";
		repo.cat(null, path, function(blob) { callback(null, blob); } );
	} else {
		var dirname = settings.workspace_directory + "/" + patch.id;

		if ((path in patch.files) && patch.files[path].method == "raw" && !with_base_content) {
			// If the entire new content is stored raw, and the caller doesn't need
			// the base content, just load the file and return.
			fs.readFile(dirname + "/" + patch.files[path].storage, { encoding: "utf8" }, function(err, data) { if (err) throw err; callback(null, data); });
			return;
		}

		// Ask the base revision for its current content. We don't need *its* base.
		load_patch_from_uuid(patch.base, function(base) {
			exports.get_patch_file_content(base, path, false, function(dummy, base_content) {
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

exports.write_changed_file = function(patch, filename, new_content) {
  	var needs_save = false;

	if (!(filename in patch.files)) {
		// How should we store the changes on disk?
		patch.files[filename] = {
			storage: filename.replace(/\//g, "_"),
			method: "raw"
		};
		needs_save = true;
	}

	fs.writeFileSync(
		settings.workspace_directory + "/" + patch.id + "/" + patch.files[filename].storage,
		new_content);

	if (needs_save)
		write_patch(patch);
}

exports.rename_patch = function(patch, new_id, callback) {
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
		settings.workspace_directory + "/" + patch.id,
		settings.workspace_directory + "/" + new_id,
		function(err) {
			if (!err)
				callback(null, exports.load_patch(new_id));
			else
				callback(""+err);
		});
}

exports.delete_patch = function(patch, callback) {
	// Delete a patch, but only if the patch doesn't actually make any changes.

	// A root patch can't be deleted if there are patches that referecne it because
	// we can't re-assign their base patch to nothing.
	if (patch.children.length > 0 && patch.type == "root") {
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
				exports.get_patch_file_content(patch, path, true,
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
						load_patch_from_uuid(child_uuid, function(child_patch) {
							// and then updates the child...
							child_patch.base = patch.base;
							write_patch(child_patch);

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
					load_patch_from_uuid(patch.base, function(base_patch) {
						base_patch.children = base_patch.children.filter(function(child_uuid) { child_uuid != patch.uuid });
						write_patch(base_patch);
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
