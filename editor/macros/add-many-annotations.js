// Adds an annotation to each section in a list of sections.

exports.macro_type = "patch";

exports.title = "add many annotations";

exports.get_form = function(context) {
	// Renders some HTML to display to the user before
	// executing the actual macro. Include form elements
	// to collect information from the user.

	var swig  = require('swig');
	var form_template = swig.compileFile(module.filename.replace(/\.js$/, '.html'));
	return form_template(context);
};

exports.apply = function(form) {
	// Execute the macro. Return some text to display to
	// the user after the macro finishes. Or return null
	// to just have the page automatically reloaded.

	return null;
};
