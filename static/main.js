var global_modal_state = null;
var global_modal_funcs = null;

$(function() {
	$('#global_modal .btn-danger').click(function() {
		// Don't take action now. Wait for the modal to be totally hidden
		// so that we don't attempt to show another modal while this one
		// is closing.
		global_modal_state = 0; // OK
	})
	$('#global_modal .btn-default').click(function() {
		global_modal_state = 1; // Cancel
	})
	$('#global_modal').on('hidden.bs.modal', function (e) {
		// do the cancel function
		if (global_modal_state == null) global_modal_state = 1; // cancel if the user hit ESC or clicked outside of the modal
		if (global_modal_funcs && global_modal_funcs[global_modal_state])
			global_modal_funcs[global_modal_state]();
	})	
})

function show_modal_error(title, message, callback) {
	$('#global_modal .modal-dialog').addClass("modal-sm");
	$('#global_modal h4').text(title);
	$('#global_modal .modal-body').html("<p/>");
	$('#global_modal p').text(message);
	$('#global_modal .btn-default').show().text("OK");
	$('#global_modal .btn-danger').hide();
	global_modal_funcs = [callback, callback];
	global_modal_state = null;
	$('#global_modal').modal({});
}

function show_modal_confirm(title, question, verb, yes_callback, cancel_callback) {
	$('#global_modal h4').text(title);
	if (typeof question == String) {
		$('#global_modal .modal-dialog').addClass("modal-sm");
		$('#global_modal .modal-body').html("<p/>");
		$('#global_modal p').text(question);
	} else {
		$('#global_modal .modal-dialog').removeClass("modal-sm");
		$('#global_modal .modal-body').html("").append(question);
	}
	$('#global_modal .btn-default').show().text("Cancel");
	$('#global_modal .btn-danger').show().text(verb);
	global_modal_funcs = [yes_callback, cancel_callback];
	global_modal_state = null;
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
