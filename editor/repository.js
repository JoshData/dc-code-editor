// Utilities for accessing the git repository containing a base version of the code.

var settings = require("./settings.js");

function execute_git(args, callback) {
	// Executes 'git' in a shell, captures its output to stdout,
	// and sends that output to 'callback'.
	//
	// If installing nodegit worked I'd use that, but since that's
	// tricky and involves compiling C code this is more portable
	// anyway, perhaps.

	var child_process = require("child_process");
	var output = "";
	var git = child_process.spawn(
		"git",
		args,
		{
			encoding: 'utf8',
			cwd: settings.code_directory
		});
	git.stdout.on('data', function (data) {
	  output += data;
	});
	git.on('close', function(exit_code) {
		if (exit_code != 0) throw "git returned non-zero exit status";
		callback(output);
	});
}

exports.get_repository_head = function(callback) {
	// Gets the hash corresponding to the head commit of the main branch (asynchronously).
	execute_git(["show", settings.code_branch], function(output) {
		var first_line = output.split("\n")[0].split(" ");
		if (first_line[0] != "commit") throw "invalid git output";
		callback(first_line[1]);
	});
}

exports.ls_hash = function(hash, recursive, callback) {
	// Gets the directory listing corresponding to a hash, asynchronously. Calls callback
	// with an array of directory entries, each an object with 'name', 'hash', 'type',
	// and 'size' properties. Type is 'blob' (file) or 'tree' (directory). To move to
	// a subdirectory, pass the hash associated with the subdirectory entry.
	if (!hash) {
		exports.get_repository_head(function(head_hash) {
			exports.ls_hash(head_hash, recursive, callback);
		});
	} else {
		execute_git(["ls-tree", "-lz" + (recursive ? 'r' : ''), hash],
		function(output) {
			var raw_entries = output.split("\0");
			var entries = [];
			raw_entries.forEach(function(item) {
				if (item.length == 0) return;
				item = item.split("\t");
				var filename = item[1];
				item = item[0].split(" ");
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
}

exports.ls = function(hash, path, callback) {
	exports.ls_hash(hash, false, function(entries) {
		if (!path) {
			callback(entries);
		} else {
			var found = false;
			var path_split = path.split("/");

			entries.forEach(function(item) {
				if (item.name == path_split[0]) {
					found = true;
					path = path_split.slice(1).join("/");
					exports.ls(item.hash, path, callback);
				}
			});

			// path not found
			if (!found) callback(null);
		}
	});
}

exports.cat_hash = function(hash, callback) {
	// Gets the (string) content of a blob, i.e. a file, given its hash.
	execute_git(["show", hash], callback);
}

exports.cat = function(hash, path, callback) {
	// Gets the (string) content of a blob, i.e. a file, given its hash.
	if (!hash) {
		exports.get_repository_head(function(head_hash) {
			exports.cat(head_hash, path, callback);
		});
	} else {
		execute_git(["show", hash + ":" + path], callback);
	}
}
