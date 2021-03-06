/* This module takes an audit log repository
   and compiles out the changes into the code
   repository one commit per patch. */

var fs = require("fs");
var pathlib = require("path");
var async = require("async");
var diff = require("diff");
var moment = require('moment');
var yaml = require('js-yaml');
var temp = require("temp").track();
var mkdirp = require('mkdirp');
var csv = require('csv');

var repo = require("./repository.js");
var settings = require("./settings.js");
var patches = require("./patches.js");

exports.publish = function(message, callback) {
	exports.publish_audit_log(message, function(audit_error, audit_output) {
		if (audit_error) {
			callback(audit_error);
			return;
		}

		exports.publish_code(function(code_error, code_output) {
			if (code_error) {
				callback(code_error);
				return;
			}

			callback(null, audit_output + "\n\n" + code_output);
		});
	});
};

exports.export_to_audit_log = function(callback) {
	// Exports the public patch data to the audit log repository. Writes a local
	// commit to the audit log.

	prepare_audit_scratch_dir(function(dirPath, last_step) {
		patches.getTree(function(patch_history) {
			write_patches(dirPath, patch_history, function(err) {
				if (err) { last_step(err); return; }
				do_commit(dirPath, last_step);
			});
		});
	})

	function prepare_audit_scratch_dir(next_step) {
		// To ensure we commit exactly the right thing, we'll start off with
		// an empty directory. If we were to use an existing directory we
		// might accidentally commit existing files that are no longer
		// wanted.
		temp.mkdir('dc-code-editor-audit-scratch-', function(err, dirPath) {
			// ...And symlink in the audit repository's .git directory.
			// That might put the real audit repo directory into a weird
			// state between the index and working copy.
			fs.symlinkSync(
				pathlib.join(settings.audit_repo_directory, ".git"),
				pathlib.join(dirPath, ".git"))

			next_step(
				dirPath,
				function(err) {
					// Clear temporary directory when everything is finished.
					temp.cleanupSync();

					// Reset the real audit directory to have checked out
					// the new head.
					repo.clean_working_tree(settings.audit_repo_directory, function() {
						// And return control to the caller.
						callback(err);
					})
				})
		});
	}

	function write_patches(dirPath, patch_history, callback) {
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

		// stop at the first draft
		for (var i = 0; i < patch_history.length; i++) {
			if (patch_history[i].draft) {
				patch_history = patch_history.slice(0, i);
				break;
			}
		}

		if (patch_history.length == 0) {
			callback("There is nothing to export.");
			return;
		}

		fs.writeFileSync(pathlib.join(dirPath, "index.yaml"), yaml.safeDump({
			"root": {
				"id": root_patch.id,
				"hash": root_patch.hash,
			},
			"patches": patch_history.map(function(patch) { return patch.id }),
		}));

		// Mark the previous patch on each patch.
		patch_history[0].base_patch_id = root_patch.id;
		for (var i = 1; i < patch_history.length; i++)
			patch_history[i].base_patch_id = patch_history[i-1].id;

		// Put the path info on the patch objects to simplify passing things
		// around.
		for (var i = 0; i < patch_history.length; i++)
			patch_history[i].export_path = pathlib.join(dirPath, patch_history[i].id);

		// Write all of the patches and call the callback when done.
		async.map(patch_history, write_patch, callback);
	}

	function write_patch(patch, callback) {
		// sanity checks
		if (!patch.effective_date) { callback("Patch " + patch.id + " does not have an effective date set."); return; }
		if (patch.draft) { callback("Patch " + patch.id + " is marked as a draft."); return; }

		var fn = pathlib.join(patch.export_path, "metadata.yaml");
		mkdirp(pathlib.dirname(fn), function(err) {
			if (err) { callback(err); return; }

			// write the patch's metadata
			fs.writeFileSync(fn, yaml.safeDump({
				"id": patch.uuid,
				"previous": patch.base_patch_id,
				"created": patch.created.toISOString(),
				"effectiveDate": moment(patch.effective_date).toISOString(),
				"actNumber": patch.metadata.actNumber || null,
				"notes": patch.notes || null,
			}));

			// for each changed path in the patch, write a unified diff to a patch file
			async.map(
				Object.keys(patch.files),
				function(changed_path, callback) {
					patch.getPathContent(changed_path, true, function(base_content, current_content) {
						write_path_diff(patch, changed_path, base_content, current_content, callback);
					});
				},
				callback
			);
		});
	}

	function write_path_diff(patch, changed_path, base_content, current_content, callback) {
		// Writes the content to the working tree path. 
		var fn = pathlib.join(patch.export_path, changed_path + ".patch");
		mkdirp(pathlib.dirname(fn), function(err) {
			if (err)
				callback(err)
			else
				fs.writeFile(
					fn,
					diff.createPatch(changed_path,
						base_content,
						current_content,
						patch.base_patch_id,
						patch.id) ,
					callback);
		});
	}

	function do_commit(dirPath, next_step) {
		repo.get_commit_message(dirPath, "HEAD", function(commit_date, existing_message) {
			var draft_message = "unpublished-draft-commit";
			var amend = (existing_message == draft_message);
			repo.commit(
				dirPath,
				draft_message,
				settings.public_committer_name,
				settings.public_committer_email,
				"now", // automatic date (when amending, resets date of commit)
				false, // don't sign
				amend,
				next_step
			);
		});
	}
}

exports.publish_audit_log = function(message, callback) {
	// Amend the top audit-log commit with the given message, push the
	// commit to the origin audit-log repository, then compile-out the
	// code into the code repository, and push that.
	repo.commit(
		settings.audit_repo_directory,
		message,
		settings.public_committer_name,
		settings.public_committer_email,
		"now", // automatic date (when amending, resets date of commit)
		false, // don't sign
		true, // amend
		function(error, output) {
			if (error) {
				callback("audit log export error: " + error);
				return;
			}

			// Push to remote repository.
			repo.push(settings.audit_repo_directory, "HEAD:master",
				function(push_error, push_output) {
				if (push_error) {
					callback("audit log push error: " + push_error);
					return;
				}

				callback(null,
					"audit log commit:\n"
					+ output + "\n\n"
					+ "audit log push:\n"
					+ push_output
				);
			});
		}
	);	
}

exports.compile_code = function(callback) {
	var audit_log = yaml.safeLoad(fs.readFileSync(pathlib.join(settings.audit_repo_directory, 'index.yaml')));

	// Checkout the root commit.
	repo.clean_working_tree(settings.code_directory, function() {
		repo.checkout_detached_head(
			settings.code_directory,
			audit_log.root.hash, // root commit of the patch tree
			function(err) {
				if (err) {
					callback(err);
					return;
				}

				// Initialize an update chart.
				var update_chart_fn = pathlib.join(settings.code_directory, 'update-chart.csv');
				fs.writeFileSync(update_chart_fn, "act,effective_date,guid\n");

				// Commit the patches one by one.
				async.eachSeries(
					audit_log.patches,
					function(patch, cb) {
						// Commit this patch.
						var root = pathlib.join(settings.audit_repo_directory, patch);
						var patch_metadata = yaml.safeLoad(fs.readFileSync(pathlib.join(root, "metadata.yaml")));

						// Skip the patch if its effective date is in the future.
						if (moment().isBefore(moment(patch_metadata.effectiveDate))) {
							cb();
							return;
						}

						// Don't duplicate this. Kind of confusing.
						delete patch_metadata.previous;

						// Modify the working tree according to the patch files.
						var files = findFiles(root, '', []);
						for (var i = 0; i < files.length; i++) {
							// Apply patch files.
							if (!/\.patch$/.exec(files[i])) continue;

							var unifieddiff = fs.readFileSync(pathlib.join(root, files[i]), { encoding: "utf-8" });

							var fn = pathlib.join(settings.code_directory, files[i].substring(0, files[i].length-6));
							var base = "";
							if (fs.existsSync(fn))
								base = fs.readFileSync(fn, { encoding: "utf-8" });
							
							fs.writeFileSync(fn, diff.applyPatch(base, unifieddiff));
						}

						// Write basic <recency> information. Omit the parts related to
						// the publication of the Code as a whole so that we don't cause
						// hashes to change unnecessarily in past laws each time the code
						// is published.
						var indexfn = pathlib.join(settings.code_directory, 'index.xml');
						var xml = fs.readFileSync(indexfn, { encoding: 'utf8' });
						xml = xml.replace(
							/<recency>[\w\W]*<\/recency>/,
							"<recency>"
							+ "\n      <last-act>D.C. Act " + patch_metadata.actNumber + "</last-act>"
							+ "\n      <effective-date>" + moment(patch_metadata.effectiveDate).format() + "</effective-date>"
							+ "\n    </recency>");
						fs.writeFileSync(indexfn, xml);

						// Append to update chart if this patch is for an act.
						if (patch_metadata.actNumber) {
							var updt = fs.readFileSync(update_chart_fn, { encoding: 'utf8' });
							updt += patch_metadata.actNumber
								+ "," + moment(patch_metadata.effectiveDate).format()
								+ "," + patch_metadata.id
								+ "\n";
							fs.writeFileSync(update_chart_fn, updt);
						}

						// Make a commit.
						repo.commit(
							settings.code_directory,
							patch + "\n\n" + yaml.safeDump(patch_metadata),
							settings.public_committer_name,
							settings.public_committer_email,
							patch_metadata.effectiveDate,
							false, // don't sign because it will change the hash
							false, // don't amend
							function(commit_output) {
								cb() // done
							});

					},
					function(err) {
						if (err) {
							callback(err);
							return;
						}

						// Update recency metadata in a final commit on the new tag.
						update_recency(function(publication_date) {
							// Make a (signed?) tag for the last commit. We don't sign
							// the individual commits because each time we export the
							// hashes will change. Rather, we want to take advantage of
							// the hashes being stable (so long as the patch doesn't change)
							// so that re-exporting over and over won't blow up the repository.
							repo.get_repository_head(settings.code_directory, null, function(hash) {
								var tag_name = "update_" + publication_date.format().replace(/[^0-9]/g, "");
								repo.tag(
									settings.code_directory,
									hash,
									tag_name,
									"official code export",
									false,
									settings.public_committer_name,
									settings.public_committer_email,
									function() {
										callback(null, tag_name)
									});
							});
						})
					}
				);
			}
		)
	});
}

function update_recency(callback) {
	repo.get_repository_head(settings.audit_repo_directory, null, function(hash) {
		repo.get_commit_message(settings.audit_repo_directory, hash, function(commit_date, message) {
			get_recency_description(function(last_act, effective_date) {
				// Replace <recency>.
				var indexfn = pathlib.join(settings.code_directory, 'index.xml');
				var xml = fs.readFileSync(indexfn, { encoding: 'utf8' });
				xml = xml.replace(
					/<recency>[\w\W]*<\/recency>/,
					"<recency>"
					+ "\n      <last-act>" + last_act + "</last-act>"
					+ "\n      <effective-date>" + effective_date.format() + "</effective-date>"
					+ "\n      <publication-date>" + commit_date.format() + "</publication-date>"
					+ "\n      <audit-log-commit>" + hash + "</audit-log-commit>"
					+ "\n    </recency>");
				fs.writeFileSync(indexfn, xml);

				// Commit.
				repo.commit(
					settings.code_directory,
					message + "\n\n" + hash,
					settings.public_committer_name,
					settings.public_committer_email,
					commit_date.format(), // match same date as audit log's latest commit so that this is stable
					false, // sign?
					false, // don't amend
					function(commit_output) {
						callback(commit_date) // done
					});
			});
		})
	});
}

function get_recency_description(callback) {
	// Get a nice description of most recent act codified.
	var update_chart_fn = pathlib.join(settings.code_directory, 'update-chart.csv');
	var update_chart = fs.readFileSync(update_chart_fn, { encoding: 'utf8' });
	csv.parse(update_chart, function(err, data) {
		var most_recent_act = data[data.length-1][0];
		var most_recent_eff_date = data[data.length-1][1];
		callback("DC Act " + most_recent_act, moment(most_recent_eff_date))
	})
}
exports.publish_code = function(callback) {
	// Compile out to the code repository.
	exports.compile_code(function(compile_err, compile_tag) {
		if (compile_err) {
			callback("code compiler error: " + compile_err);
			return;
		}
		
		// Push the code repository.
		repo.push(settings.code_directory, "tags/"+compile_tag,
			function(push_error, push_output) {
			if (push_error) {
				callback("code push error: " + push_error);
				return;
			}

			callback(null,
				"code repository new tag:\n"
				+ compile_tag + "\n\n"
				+ "code push output:\n"
				+ push_output);
		});
	}) 	
}

function findFiles(root, path, result) {
	var abspath = pathlib.join(root, path);
	var s = fs.lstatSync(abspath);
	if (!s.isDirectory()) {
		result.push(path);
	} else {
		var children = fs.readdirSync(abspath);
		for (var i = 0, l = children.length; i < l; i ++)
			findFiles(root, pathlib.join(path, children[i]), result)
	}
	return result;
}


// When called directly from the command line...
if (require.main === module) {
	if (!process.argv[2]) {
		console.log("usage: node editor/publish.js compile-code")
		process.exit()
	}

	if (process.argv[2] == "compile-code") {
	
		exports.compile_code(function(error, output) {
			console.log(error || output)
		})
	}
}
