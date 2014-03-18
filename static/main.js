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

var is_ajax_loading = false;
function ajax_call(url, data, success_callback, modal_error_title, failure_callback) {
	// Show a modal progress indicator that prevents other page interactions
	// while the call is processing. Delay before showing the indicator so
	// that we don't flash something only just for a moment.
	is_ajax_loading = true;
	setTimeout("if (is_ajax_loading) $('#ajax_loading_indicator').fadeIn()", 100);
	function hide_loading_indicator() {
		is_ajax_loading = false;
		$('#ajax_loading_indicator').hide();
	}

	$.ajax(
		url,
		{
			data: data,
			method: "POST",
			success: function(res) {
				hide_loading_indicator();
				if (res.status == "error") {
					show_modal_error(modal_error_title, res.msg);
					if (failure_callback) failure_callback();
				}
				else {
					success_callback(res);
				}
			},
			error: function() {
				hide_loading_indicator();
				show_modal_error(modal_error_title, "Sorry, an internal error occurred.");
				if (failure_callback) failure_callback();
			}
	});
}
