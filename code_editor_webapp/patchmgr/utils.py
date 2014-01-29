from django.http import HttpResponse 
from django import forms
from django.conf import settings

import json

def json_response(f):
	"""Turns dict output into a JSON response."""
	def g(*args, **kwargs):
		try:
			ret = f(*args, **kwargs)
			if isinstance(ret, HttpResponse):
				return ret
			ret = json.dumps(ret)
			resp = HttpResponse(ret, mimetype="application/json")
			resp["Content-Length"] = len(ret)
			return resp
		except ValueError as e:
			return HttpResponse(json.dumps({ "status": "fail", "msg": str(e) }), mimetype="application/json")
		except forms.ValidationError as e:
			return HttpResponse(json.dumps({ "status": "fail", "msg": str(e), "field": getattr(e, "source_field", None) }), mimetype="application/json")
		except Exception as e:
			if settings.DEBUG:
				raise
			return HttpResponseServerError(json.dumps({ "status": "generic-failure", "msg": str(e) }), mimetype="application/json")
	return g
	
