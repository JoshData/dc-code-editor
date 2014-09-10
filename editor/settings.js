exports.workspace_directory = __dirname + "/../workspace";

exports.code_directory = __dirname + "/../base_code";
exports.code_branch = 'gh-pages';

exports.committer_name = "Council of the District of Columbia";
exports.committer_email = "official-dc-code@dccouncil.us"

exports.authorized_users = [
	{
		username: "test",
		password: "pw"
	}
];

// If settings_local.js is present in the base directory, replace
// our exports with its exports.
var fs = require("fs");
if (fs.existsSync("settings_local.js")) {
	var settings_local = require("../settings_local.js");
	for (k in exports) {
		exports[k] = settings_local[k];
	}
}
