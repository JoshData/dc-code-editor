var clone = require('clone');
var async = require('async');

Patch.prototype.get_jot_operations = function(callback) {
	/* Computes an array of JOT object APPLY operations that represent the changes
	   made by this patch. Passes the array to the callback. Each APPLY operation
	   encodes which path it is for. */

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
							jot_sequences.from_diff(
								base_content,
								current_content,
								"words"
							)
						)
					)
				);
			});
		},
		function(err, results) {
			callback(results);
		}
	);	
};

Patch.prototype.compute_rebase = function(jot_op, callback) {
	// Computes the rebase of the *subtree* headed by this patch
	// against jot_op, which is a JOT operation object representing
	// the changes made in the patch we are rebasing against.
	//
	// If stop_at is a Patch, then we recurse only as deeply as
	// as that patch.

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
				rebase_data.children || [],
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

exports.merge_up = function(patch, callback) {
	/* Merges a patch with its parent, rebasing any other children of the parent. 
	   If the patch has children, the children are moved to be the children of
	   the patch's base. */

	if (patch.type == "root") {
		callback("Cannot merge up a root patch.");
		return;
	}

	// First turn the patch into a JOT operation.
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

					// for each modified path in the patch, save the new content
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
							// base patch has been modified in place, the patch's state is already
							// inconsistent anyway. Deleting also has the effect of re-setting the patch's
							// children's bases to be the patch's base rather than the patch itself,
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
										callback(err, base_patch); // done, possibly with an error
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

exports.move_to = function(patch, new_base, callback) {
	/* Reorders the patches. We may be in one of two situations. First
	   check who is a descendant of who. */

	if (patch.id == new_base.id) {
		callback("Cannot move a patch to be a child of itself.")
		return;
	}

	async.map(
		[patch, new_base],
		function(item, callback) { item.getAncestors(function(ancestors) { callback(null, ancestors); }); },
		function(err, results) {
			// Who is in whose ancestor list.

			// Is new_base an ancestor of patch?
			for (var i = 0; i < results[0].length; i++) {
				if (results[0][i].id == new_base.id) {
					move_to_(-1, patch, new_base, results[0].slice(i+1), callback);
					return;
				}
			}

			// Is patch an ancestor of new_base?
			for (var i = 0; i < results[1].length; i++) {
				if (results[1][i].id == patch.id) {
					move_to_(1, patch, new_base, results[1].slice(i+1), callback);
					return;
				}
			}

			callback("You cannot move that patch there.")
		});
}

function move_to_(direction, patch, new_base, route, callback) {
	/* Reorders patches. We may be in one of two cases.

	A) direction == -1. The patch is a descendant of new_base.

	   Move around patches so that
	     new_base C1 ... CN patch D1
	   becomes
	     new_base patch C1 ... CN D1

	   Which means:
	     * C1, new_base's child and an ancestor of patch, goes from being a child of new_base to being a child of patch
	     * patch goes from being a child of CN to being a child of new_base
	     * D1, patch's first child, becomes a child of CN (other children of patch are not affected and are carried along)

	B) direction == +1. The patch is an ancestor of new_base.

	   Move around patches so that
	     P patch C1 ... new_base D1
	   becomes
	     P C1 ... new_base patch D1

	   But C1 may not be present. If C1 is present, this means:
	     * C1, patch's child and an ancestor of new_base, goes from being a child of patch to being a child of P
	     * patch goes from being a child of P to being a child of new_base
	     * D1, new_base's first child, becomes a child of patch (other children of new_base are not affected)

	   If C1 is not present,
	     * new_base, which is patch's child, becomes a child of P
	     * patch goes from being a child of P to being a child of new_base
	     * D1, new_base's first child, becomes a child of patch (other children of new_base are not affected)

	We can think about this operation as iteratively reversing the
	order of patch and either its base or first child until we've
	flipped patch and C1 or new_base.

	TODO: If there are intermediate children they need to be rebased too? And on patch
	and new_base?

	*/

	if (direction == -1 && patch.base == new_base.uuid) {
		callback("Nothing to do.");
		return;
	}

	if (direction == 1 && patch.type == "root") {
		callback("A root patch cannot be moved.")
		return;
	}

	var root_copy = clone(route);
	if (direction == 1) {
		root_copy.push(new_base);
		root_copy.reverse();
	}

    flip_and_iterate(
    	patch,
    	function() {
    		if (root_copy.length == 0)
    			return null; // no more
    		else
    			return root_copy.pop();
    	},
    	direction,
    	function(err, rebase_data) {
    		if (err) {
    			callback(err);
    			return;
    		}

    		// Re-jigger the connectivity. This must be done before writing
    		// the rebased patch contents because that will have to look at
    		// the connectivity to compute the new states of the paths.

    		var d1_parent = (direction == -1 ? patch : new_base);
    		if (d1_parent.children.length == 0)
    			save_connectivity(null);
    		else
    			Patch.loadByUUID(d1_parent.children[0], save_connectivity);

    		function save_connectivity(d1, patch_base) {
    			if (direction == -1) {
			     	change_patch_parent(route[0], new_base, patch);
			     	change_patch_parent(patch, route[route.length-1], new_base);
			     	if (d1) change_patch_parent(d1, patch, route[route.length-1]);
			    } else {
			    	if (patch_base == null) {
						patch.getBase(function(base_patch) { save_connectivity(d1, base_patch) });
			    		return;
			    	}

			     	if (route.length > 0)
			     		change_patch_parent(route[0], patch, patch_base);
			     	else
			     		change_patch_parent(new_base, patch, patch_base);
			     	change_patch_parent(patch, patch_base, new_base);
			     	if (d1) change_patch_parent(d1, new_base, patch);
			    }

		     	// and save
		     	new_base.save();
		     	patch.save();
		     	if (patch_base) patch_base.save()
		     	if (d1) d1.save();
		     	if (route.length > 0) route[0].save();
		     	if (route.length > 0) route[route.length-1].save();

		     	// Now save the rebased content changes. The changes must be saved
		     	// in order because each patch looks at its parent's contents.
		     	if (direction == -1) rebase_data.reverse();
		     	function save_rebased_content() {
		     		if (rebase_data.length == 0) {
		     			callback(); // done
		     		} else {
		     			var next = rebase_data.shift();
		     			next[0].save_rebase({me: next[1]}, save_rebased_content);
		     		}
		     	}
		     	save_rebased_content();
    		}
    	}
    );
}

function flip_patches_compute_rebase(a, b) {
	/* Computes the rebase required to flip two patches, where a is the parent of b.
	   The arguments a and b are arrays of JOT operations.

	   We replace b's operations with b rebased against the inverse of a, and we
	   replace a's operations with a rebased against *that* (= b rebased against
	   the inverse of a).
	*/

	var jot_base = require('../ext/jot/jot/base.js');

	var a_inv = jot_base.invert_array(a);
	var b_new = jot_base.rebase_array(a_inv, b);
	if (!b_new) return false;

	var a_new = jot_base.rebase_array(b_new, a);
	if (!a_new) return false;

	return [a_new, b_new];
}

function flip_and_iterate(starting_patch, get_next_item_func, direction, callback) {
	function iter(item1_ops, rebase_data) {
		var item2 = get_next_item_func();
		if (!item2) {
			rebase_data.push([starting_patch, item1_ops]);
			callback(null, rebase_data); // all done
			return;
		}

		item2.get_jot_operations(function(item2_ops) {
			var rebases;
			if (direction == 1) { // moving item1 to the right
				rebases = flip_patches_compute_rebase(item1_ops, item2_ops);
			} else if (direction == -1) { // moving item1 to the left
				rebases = flip_patches_compute_rebase(item2_ops, item1_ops);
				if (rebases) rebases = [rebases[1], rebases[0]];
			}

			if (!rebases) {
				// fail
				callback("The patch cannot be moved. There is a conflict with " + item2.id + ".");
			} else {
				rebase_data.push([item2, rebases[1]]); // because item2 is now moved and finished
				iter(rebases[0], rebase_data); // because item1 is carried forward to the next flip
			}
		});
	}

	starting_patch.get_jot_operations(function(item1_ops) {
		iter(item1_ops, [])
	});
}

function change_patch_parent(patch, old_parent, new_parent) {
	patch.base = new_parent.uuid;
	old_parent.children.splice(old_parent.children.indexOf(patch.uuid), 1);
	new_parent.children.push(patch.uuid);
}
