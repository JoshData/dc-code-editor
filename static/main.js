function show_modal_error(title, message) {
	$('#error_modal h4').text(title);
	$('#error_modal p').text(message);
	$('#error_modal').modal({});
}