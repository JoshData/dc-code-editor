var global_modal_ok_func = null;

$(function() {
	$('#global_modal .btn-danger').click(function() {
		if (global_modal_ok_func)
			global_modal_ok_func();
	})
})

function show_modal_error(title, message) {
	$('#global_modal h4').text(title);
	$('#global_modal p').text(message);
	$('#global_modal .btn-default').show().text("OK");
	$('#global_modal .btn-danger').hide();
	global_modal_ok_func = null;
	$('#global_modal').modal({});
}

function show_modal_yes_no_question(title, question, yes_callback) {
	$('#global_modal h4').text(title);
	$('#global_modal p').text(question);
	$('#global_modal .btn-default').show().text("No");
	$('#global_modal .btn-danger').show().text("Yes");
	global_modal_ok_func = yes_callback;
	$('#global_modal').modal({});
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
