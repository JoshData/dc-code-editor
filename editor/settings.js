exports.site_secret_key = "changeme";

exports.workspace_directory = __dirname + "/../workspace";

exports.code_directory = __dirname + "/../base_code";
exports.code_branch = 'gh-pages';

exports.public_committer_name = "Council of the District of Columbia";
exports.public_committer_email = "official-dc-code@dccouncil.us"

exports.authorized_users = [
	{
		username: "test",
		password: "pw",
		committer_name: "Test User",
		committer_email: "test@dccouncil.us",
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
