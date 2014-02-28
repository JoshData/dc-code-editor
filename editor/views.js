var swig  = require('swig');
var pathlib  = require('path');
var async = require('async');
var patches = require("./patches.js");

exports.set_routes = function(app) {
	// Home Screen
	var home_template = swig.compileFile(__dirname + '/templates/index.html');
	app.get('/', function(req, res){
		res.setHeader('Content-Type', 'text/html');
		patches.get_patch_tree(function(patch_list) {
			res.send(home_template({ patch_list: patch_list }));
		});
	});

	// Patch Edit
	var show_patch_template = swig.compileFile(__dirname + '/templates/show_patch.html');
	app.get('/patch/:patch', function(req, res){
		res.setHeader('Content-Type', 'text/html');

		var patch = patches.load_patch(req.params.patch);

		async.parallel(
		{
			// get the list of editable files
			file_list: function(callback) {
				patches.get_file_list(
					patch, req.query.path, true,
					function(file_list) {
						callback(null, file_list); // null=no error
					});
				},

			// get a diff of the changes made by this patch
			diffs: function(callback) { patches.get_patch_diff(patch, function(diffinfo) { callback(null, diffinfo); } ); }
		},
		function(err, result) {
			// for navigating the files, which is the parent directory path?
			var path_up = null;
			if (req.query.path)
				path_up = pathlib.dirname(req.query.path);

			res.send(show_patch_template({
				patch: patch,
				files: result.file_list,
				path: req.query.path,
				path_up: path_up,
				diffs: result.diffs
			}));
		});
	});

	// New Patch
	app.get('/patch/:patch/_new', function(req, res){
		var patch = patches.load_patch(req.params.patch);
		patch = patches.create_patch_from(patch);
		res.redirect(patch.edit_url);
	});

	// Rename/Delete Patch
	app.post('/patch/:patch/_action', function(req, res){
		var patch = patches.load_patch(req.params.patch);
		if (req.body.action == "rename") {
			var new_id = req.body.value;
			patches.rename_patch(patch, new_id, function(status, new_patch) {
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
		}
		if (req.body.action == "delete") {
			patches.delete_patch(patch, function(status) {
				res.setHeader('Content-Type', 'application/json');
				if (!status) {
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
			});
		}
	});

	// File Edit
	var edit_file_template = swig.compileFile(__dirname + '/templates/edit_file.html');
	app.get('/patch/:patch/editor', function(req, res){
		res.setHeader('Content-Type', 'text/html');
		var patch = patches.load_patch(req.params.patch);
		var filename = req.query.file;

		patches.get_patch_file_content(patch, filename, true, function(base_text, current_text) {
			res.send(edit_file_template({
				patch: patch,
				filename: filename,
				base_text: JSON.stringify(base_text),
				current_text: current_text
			}));
		})
	});

	// Save a modified file in a patch.
	app.post('/save-patch-file', function(req, res){
		var patch = patches.load_patch(req.body.patch);
		var filename = req.body.file;
		var newtext = req.body.text;

		patches.write_changed_file(patch, filename, newtext)

		res.setHeader('Content-Type', 'application/json');
		res.send(JSON.stringify({
			"status": "ok",
		}));
	});

	// Render a Section
	app.post('/render-body', function(req, res){
		// Use simple-2 to render the section.

		var et = require('elementtree');
		var render_body = require('../ext/simple-2/render_body.js');

		var dom;
		try {
		 dom = et.parse(req.body.text)._root;
		} catch (e) {
			res.writeHead(400, {'Content-Type': 'application/json'});
			res.write(JSON.stringify( { "error": "Invalid XML: " + e } ));
			res.end();
			return;
		}

		var body;
		try {
			body = render_body.render_body("file.html", dom, null, null, null);
		} catch (e) {
			res.writeHead(400, {'Content-Type': 'application/json'});
			res.write(JSON.stringify( { "error": "Something is wrong in the code: " + e } ));
			res.end();
			return;
		}

		res.setHeader('Content-Type', 'application/json');
		res.send(JSON.stringify({
			"status": "ok",
			"html": body.rendered
		}));
	});
}