// Main entry point for the application server.

check_can_start();
start_server();

function start_server() {
	var port = 8000;

	var express = require('express');

	var app = express();

	// general configuration
	app.set('title', 'Legal Code Editor');
	app.use(express.bodyParser());
	app.use("/static", express.static('static'))

	// configure routes
	var views = require('./views.js');
	views.set_routes(app);

	// error conditions
	app.use(function(req, res, next){
	  res.send(404, 'Invalid URL.');
	});

	console.log("listening on port", port);
	app.listen(port);
}

function check_can_start() {
	// check that things are in place
	var settings = require("./settings.js");
	var path = require("path");
	var fs = require("fs");
	if (!fs.existsSync(settings.code_directory)) throw "Clone the code repository in " + path.normalize(settings.code_directory);
}
