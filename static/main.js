function show_modal_error(title, message) {
	$('#error_modal h4').text(title);
	$('#error_modal p').text(message);
	$('#error_modal').modal({});
}

function ajax_call(url, data, success_callback, modal_error_title) {
	$.ajax(
		url,
		{
			data: data,
			method: "POST",
			success: function(res) {
				if (res.status == "error")
					show_modal_error(modal_error_title, res.msg);
				else
					success_callback(res);
			},
			error: function() {
				show_modal_error(modal_error_title, "Sorry, an internal error occurred.");
			}
	});
}
