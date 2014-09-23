// Utilities for accessing the git repository containing a base version of the code.

var fs = require("fs");
var pathlib = require("path");
var moment = require('moment');

function execute_git(dir, args, env, callback) {
	// Executes 'git' in a shell, captures its output to stdout,
	// and sends that output to 'callback'.
	//
	// If installing nodegit worked I'd use that, but since that's
	// tricky and involves compiling C code this is more portable
	// anyway, perhaps.

	var child_process = require("child_process");
	var output = "";
	var error_output = "";
	var git = child_process.spawn(
		"git",
		args,
		{
			env: env,
			encoding: 'utf8',
			cwd: dir
		});
	//console.log("git", dir, args, env);
	git.stdout.on('data', function (data) {
	  output += data;
	});
	git.stderr.on('data', function (data) {
	  error_output += data;
	});
	git.on('close', function(exit_code) {
		if (exit_code != 0) {
			if (env && env.capture_error) {
				callback(error_output);
				return;
			}

			console.log(error_output);
			console.log(output);
			throw "git returned non-zero exit status. Arguments: " + args.join(", ");
		} else if (env && env.capture_error) {
			callback(null, output);
		} else {
			callback(output);
		}
	});
}

exports.get_repository_head = function(dir, branch, callback) {
	// Gets the hash corresponding to the head commit of a branch (asynchronously).
	var args = ["show"];
	if (branch) args.push(branch);
	execute_git(dir, args, null, function(output) {
		var first_line = output.split("\n")[0].split(" ");
		if (first_line[0] != "commit") throw "invalid git output";
		callback(first_line[1]);
	});
}

exports.get_commit_message = function(dir, commit, callback) {
	execute_git(dir,
		["log", "-n1", "--format=%B", commit],
		null,
		function(message) {
			// Strip the message because we seem to get back trailing
			// newlines.
			message = message.replace(/\s+$/, '');
			callback(message);
		});
}

exports.ls = function(dir, hash, path, recursive, callback) {
	// Gets the directory listing corresponding to a commit hash and a particular
	// path (null for the root path), asynchronously.
	//
	// Calls callback with an array of directory entries, each an object with
	// 'name', 'hash', 'type', and 'size' properties. Type is 'blob' (file) or
	// 'tree' (directory).
	//
	// In the git call below, '-z' turns on null byte line endings, '-l' adds
	// file sizes, and '-r' produces recursive output.

	// To get the listings inside a directory, the path must end in a slash.
	if (path && path[path.length-1] != '/') path += '/';

	execute_git(dir, ["ls-tree", "-lz" + (recursive ? 'r' : ''), hash, (!path ? '' : path)], null,
	function(output) {
		var raw_entries = output.split("\0");
		var entries = [];
		raw_entries.forEach(function(item) {
			if (item.length == 0) return;
			item = item.split("\t");
			var filename = item[1];
			item = item[0].split(" ");

			// returned entries should be relative paths instead of
			// absolute paths
			if (path) {
				if (filename.substring(0, path.length) != path) throw "Invalid path?";
				filename = filename.substring(path.length);
			}

			entries.push({
				type: item[1],
				hash: item[2],
				size: item[3],
				name: filename
			})
		});
		callback(entries);
	});
}

exports.cat_hash = function(dir, hash, callback) {
	// Gets the (string) content of a blob, i.e. a file, given its hash.
	execute_git(dir, ["show", hash], null, callback);
}

exports.cat = function(dir, hash, path, callback) {
	// Gets the (string) content of a blob, i.e. a file, given its hash.
	execute_git(dir, ["show", hash + ":" + path], null, callback);
}

exports.branch = function(dir, branch_name, base_commit, callback) {
	execute_git(dir, ["checkout", "-b", branch_name, base_commit ], null, function(output) { callback(); });
}

exports.checkout_detached_head = function(dir, head, callback) {
	execute_git(dir, ["checkout", head ], null, function(output) { callback(); });
}

exports.clean_working_tree = function(dir, callback) {
	// Calls "git reset --hard".
	execute_git(dir, ["reset", "--hard" ], null, function(output) { callback(); });
}

exports.is_working_tree_dirty = function(dir, callback) {
	execute_git(dir, ["status"], null, function(status_output) {
		if (status_output.indexOf("nothing to commit, working directory clean") != -1)
			callback(false);
		else
			callback(true);
	});
}

exports.word_diff = function(dir, commit, callback) {
	execute_git(dir, ["diff", "--word-diff=porcelain", "-M", commit], null, callback);
}

exports.commit = function(dir, message, author_name, author_email, commit_date, sign, amend, callback) {
	// Performs a commit using "git add -A" and "git commit".
	execute_git(dir, ["add", "-A"], null, function() {
		exports.is_working_tree_dirty(dir, function(is_dirty) {
			if (!is_dirty && !amend) {
				// Nothing to commit. Silently don't do a commit.
				callback("Nothing to commit.");
				return;
			}

			// don't sign the commits so long as we're expecting tha re-exporting a patch
			// should not change the commit hash, because signing a commit makes the hash
			// sensitive to the current time (or at least something that changes each time)
			var args = ["commit", "-m", message];
			
			if (sign) args.push("-S");
			if (amend) { args.push("--amend"); args.push("--reset-author"); }
			if (commit_date == "now")
				commit_date = moment().format(); // current time in local time w/ timezone
				// new Date().toISOString() returns the correct time but loses
				// the locale's timezone which would be nice to keep.

			execute_git(
				dir,
				args,
				{
		           GIT_AUTHOR_NAME: author_name,
		           GIT_AUTHOR_EMAIL: author_email,
		           GIT_AUTHOR_DATE: commit_date ? commit_date : "",
		           GIT_COMMITTER_NAME: author_name,
		           GIT_COMMITTER_EMAIL: author_email,
		           GIT_COMMITTER_DATE: commit_date ? commit_date : "",
				},
				function(output) { callback(null, output); }
			);		
		});
	})
}

exports.tag = function(dir, commit, tagname, message, sign, author_name, author_email, callback) {
	var args = ["tag", "-m", message];
	if (sign) { args.push("-s"); }
	args.push(tagname);
	args.push(commit);
	execute_git(
		dir,
		args,
		{
	        GIT_COMMITTER_NAME: author_name,
	        GIT_COMMITTER_EMAIL: author_email
	    },
		callback
	);
}

exports.check_if_gpg_key_exists = function(emailaddr, callback) {
	var child_process = require("child_process");
	var output = "";
	var error_output = "";
	var git = child_process.spawn(
		"gpg2",
		["--with-colons", "--utf8-strings", "-k", emailaddr],
		{ encoding: 'utf8' });
	git.stdout.on('data', function (data) {
	  output += data;
	});
	git.stderr.on('data', function (data) {
	  error_output += data;
	});
	git.on('close', function(exit_code) {
		callback(exit_code == 0);
	});
}

exports.push = function(dir, refspec, callback) {
	// Performs a git push.
	execute_git(dir, ["push", "--porcelain", "origin", refspec], {capture_error: true}, callback);
}
