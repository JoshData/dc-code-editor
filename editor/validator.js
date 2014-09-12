var async = require('async');
var pathlib = require("path");
var libxmljs = require("libxmljs");

var patches = require("./patches.js");

exports.validatePatch = function(patch, fast, callback) {
	// Validate the Code XML as it is in the given patch.
	// If fast is true only check changed paths. Otherwise
	// check every file in the Code XML.

	var load_paths;
	if (fast) {
		// Validate each changed path.
		load_paths = function(next) {
			// Get the changed paths.
			var paths = Object.keys(patch.files);

			// Also validate any parent file of a changed path.
			for (var i = 0; i < paths.length; i++) {
				var p = paths[i];
				while (p != 'index.xml') {
					if (pathlib.basename(p) == 'index.xml')
						p = pathlib.join(pathlib.dirname(pathlib.dirname(p)), 'index.xml');
					else
						p = pathlib.join(pathlib.dirname(p), 'index.xml');
					if (paths.indexOf(p) == -1)
						paths.push(p);
				}
			}

			next(paths);
		}
	} else {
		// Validate all paths in the patch.
		load_paths = function(next) {
			patch.getPaths(null, true, false, function(paths) {
				paths = paths
					.filter(function(pathobj) { return pathobj.type == "blob" })
					.map(function(pathobj) { return pathobj.name });
				next(paths);
			});
		}
	}

	load_paths(function(paths) {
		async.mapLimit(
			paths,
			20, // there's a limit to the number of files that can be open at once
			function(path, cb) {
				validatePath(patch, path, cb);
			},
			function(err, results) {
				// Turn the array of results by path into a mappin from path to result,
				// for paths with validation errors.
				var mapping = { };
				for (var i = 0; i < paths.length; i++)
					if (results[i] && results[i].length > 0)
						mapping[paths[i]] = results[i];
				if (mapping.length == 0) mapping = null;
				callback(mapping);
			}
		);
	})
}

function validatePath(patch, path, callback) {
	// log when running from the command line
	if (require.main === module)
		console.log(path + "...");
	// end of logging

	if (path == "README.md") {
		// Do not validate the documentation.
		callback();
		return;
	}

	var fn = pathlib.basename(path);

	patch.getPathContent(path, false, function(dummy, content) {
		// If content is null, this is a path to a deleted file.
		if (content == "") {
			callback();
			return;
		}

		// Parse the XML. If the XML is invalid, validation fails.
		try {
			dom = libxmljs.parseXml(content, {noblanks: true});
		} catch (e) {
			if (e) {
				callback(null, [e]);
				return;
			}
		}

		if (fn == "index.xml") {
			// This is a TOC level with x:includes to lower levels.
			validateIndexPath(patch, path, dom, callback);

		} else {
			// This is a section.

			// Validate the name of the file.
			callback();
		}
	});
}

function validateIndexPath(patch, path, dom, callback) {
	// Get a flat list of every node in the DOM.
	function getDescendants(node, list) {
		list.push(node);
		node.childNodes().forEach(function(child) { getDescendants(child, list) });
	}
	var nodes = [];
	getDescendants(dom.root(), nodes);

	// Check that any XInclude points to a path that exists.
	async.map(
		nodes,
		function(node, cb) {
			if (node.name() == "include") { // can't figure out how to test namespace
				if (!node.attr('href')) {
					cb(null, "XInclude is missing an href attribute.")
				} else {
					// Check that the href points to a file that exists.
					var path2 = pathlib.resolve("/" + pathlib.dirname(path), node.attr('href').value()).substring(1);
					console.log(path, path2)
					patch.pathExists(path2, false, function(exists) {
						cb(null, exists ? null : "XInclude path " + node.attr('href').value() + " is to a file that does not exist.");
					})
				}
			} else {
				cb()
			}
		},
		function(err, results) {
			callback(err, results.filter(function(x) { return x != null; }));
		})
}

// When called directly from the command line...
if (require.main === module) {
	if (!process.argv[2]) {
		console.log("usage: node editor/validator.js patchId")
		process.exit()
	}

	var p = patches.Patch.load(process.argv[2]);
	exports.validatePatch(p, true, function(results) {
		for (var path in results)
			if (results[path] != null)
				console.log(path, results[path]);
	})
}
