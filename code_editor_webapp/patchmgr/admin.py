from django.contrib import admin
from patchmgr.models import *

class PatchAdmin(admin.ModelAdmin):
	pass
	
admin.site.register(Patch, PatchAdmin)