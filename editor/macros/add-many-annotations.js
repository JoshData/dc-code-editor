// Adds an annotation to each section in a list of sections.

var path = require("path");
var async = require("async");
var libxmljs = require("libxmljs");

exports.macro_type = "patch";

exports.title = "add many annotations";

exports.get_form = function(context, callback) {
	// Renders some HTML to display to the user before
	// executing the actual macro. Include form elements
	// to collect information from the user.

	var swig  = require('swig');
	var form_template = swig.compileFile(module.filename.replace(/\.js$/, '.html'));
	callback(form_template(context));
};

exports.validate_form = function(form) {
	// Check that an annotation heading was given.
	if (!/\w/.exec(form.annotation_section))
		return "Enter the heading of the annotation section to be added to.";

	// Check that new annotation text was given.
	if (!/\w/.exec(form.annotation_text))
		return "Enter the new annotation text.";

	// Check that at least one section was entered into the form.
	if (!/\w/.exec(form.sections_affected))
		return "Enter some sections.";

	return null; // null means success
}

exports.apply = function(form, callback) {
	// Execute the macro. When the macro is done, we must
	// call callback either as callback("Error message")
	// or callback(null, "Success message.").

	// create a hash table of the sections affected provided by the
	// user for fast lookups. Set to false. We'll make them true
	// later.
	var sections_affected = { };
	form.sections_affected.split(/\s+/).forEach(function(section_name) {
		sections_affected[section_name] = false;
	});

	// Loop through every path...
	form.patch.getPaths(null, true, false, function(entries) {
		async.each(
			entries,
			function(item, callback) {
				var sec_name = path.basename(item.name).replace(/\.xml$/, '');
				if (!(sec_name in sections_affected)) {
					// this is not one of the sections we're updating
					callback();
					return;
				}

				// mark this section as seen
				sections_affected[sec_name] = true;

				// modify the file
				fixup_file(form.patch, item.name, form, callback);

			},
			function(err) {
				if (err) {
					callback(false, err);
					return;
				}

				// Which sections did we not see?
				var results = [];
				for (var sec_name in sections_affected) {
					if (!sections_affected[sec_name])
						results.push(sec_name);
				}

				if (results.length == 0)
					callback(true, "Got it!");
				else
					callback(false, "Some sections weren't found: " + results.join(", "));
			}
		);
	})
};

function fixup_file(patch, path, form, callback) {
	// load the contents of the file
	patch.getPathContent(path, false, function(dummy, file_contents) {
		// parse XML
		var dom;
		try {
			dom = libxmljs.parseXml(file_contents, {noblanks: true});
		} catch (e) {
			callback("Error in " + path + ": " + e)
			return;
		}

		// make the changes
		patch_xml(form, dom);

		// save the changes
		var xml = dom.toString();
		xml = xml.replace(/<\?xml version="1.0" encoding="UTF-8"\?>\n/, '');
		patch.writePathContent(path, xml);
		
		callback(); // signal we're done & success
	});

}

function patch_xml(form, dom) {
	var annotations = find_node(dom.root(), "annotations");
	var section = find_node(annotations, null, form.annotation_section);
	var newtext = section.node("text", form.annotation_text);
}

function find_node(dom, type, heading) {
	// find the first level whose type is type or whose heading is heading
	var levels = dom.find("level");
	for (var i = 0; i < levels.length; i++) {
		if (type && levels[i].get("type") && levels[i].get("type").text() == type)
			return levels[i];
		if (heading && levels[i].get("heading") && levels[i].get("heading").text() == heading)
			return levels[i];
	}

	// no such node
	var node = dom.node("level");
	if (type) node.node("type", type);
	if (heading) node.node("heading", heading);
	return node;
}