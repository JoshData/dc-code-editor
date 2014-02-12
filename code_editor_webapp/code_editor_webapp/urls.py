from django.conf.urls import patterns, include, url

from django.contrib import admin
admin.autodiscover()

urlpatterns = patterns('',
    # Examples:
    # url(r'^$', 'code_editor_webapp.views.home', name='home'),
    # url(r'^blog/', include('blog.urls')),

    url(r'^admin/', include(admin.site.urls)),

    url(r'^$', 'patchmgr.views.open_patch'),
    url(r'^patch/(\d+)$', 'patchmgr.views.show_patch'),
    url(r'^patch/(\d+)/_new$', 'patchmgr.views.new_patch'),
    url(r'^patch/(\d+)/_edit$', 'patchmgr.views.edit_file_redirector'),
    url(r'^patch/(\d+)/(\d+)$', 'patchmgr.views.edit_file'),
    url(r'^patch/(\d+)/_(rename)$', 'patchmgr.views.patch_action'),
    url(r'^update-change$', 'patchmgr.views.update_change'),
    url(r'^render-body$', 'patchmgr.views.render_body'),
)
