'use strict';

define('admin/plugins/mentions', ['settings'], function (Settings) {
	var ACP = {};

	ACP.init = function () {
		Settings.load('mentions', $('.mentions-settings'));

		$(window).on('action:admin.settingsLoaded', applyDefaults);

		$('#save').on('click', function () {
			Settings.save('mentions', $('.mentions-settings'), function () {
				app.alert({
					type: 'success',
					alert_id: 'mentions-saved',
					title: 'Settings Saved',
					message: 'Please reload your NodeBB to apply these settings',
					clickfn: function () {
						socket.emit('admin.reload');
					},
				});
			});
		});
	};

	function applyDefaults() {
		if (!ajaxify.data.settings || !ajaxify.data.settings.hasOwnProperty('autofillGroups')) {
			$('input#autofillGroups').parents('.mdl-switch').toggleClass('is-checked', false);
			$('input#autofillGroups').prop('checked', false);
		}
	}

	return ACP;
});
