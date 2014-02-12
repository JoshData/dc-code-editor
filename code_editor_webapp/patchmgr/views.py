from django.shortcuts import render, redirect, get_object_or_404
from django.views.decorators.csrf import csrf_protect

from patchmgr.models import Patch, ChangedFile

from patchmgr.utils import json_response

def open_patch(request):
    # ensure that a patch object for the repository's master branch head commit is present
    head = Patch.get_master_head()

    # get the most recently modified patches and display them
    patch_list = Patch.objects.filter(commit_hash=None).order_by('-modified')[:100]
    return render(request, 'patchmgr/open_patch.html', {
        'head': head,
        'patch_list': patch_list,
        })

def show_patch(request, patch_id):
    patch = get_object_or_404(Patch, pk=patch_id)

    basepath = request.GET.get("path")
    basepath = (basepath + "/") if basepath else ""
    path_up = None
    if request.GET.get("path"):
        import os.path
        path_up = os.path.dirname(request.GET.get("path"))

    return render(request, 'patchmgr/show_patch.html', {
        'patch': patch,
        'files': [(basepath+fn, fn, ftype) for (fn, ftype) in patch.base_patch.get_file_list(request.GET.get("path"))] if patch.base_patch else None,
        'path': request.GET.get("path"),
        'path_up': path_up,
        })

def new_patch(request, patch_id):
    patch = get_object_or_404(Patch, pk=patch_id)
    p = Patch.objects.create(
        title="New Patch",
        base_patch=patch,
        )
    return redirect(p)

def edit_file_redirector(request, patch_id):
    patch = get_object_or_404(Patch, pk=patch_id)
    if not patch.can_modify(): raise ValueError("This patch cannot be modified.")

    fn = request.GET.get('file')
    if not patch.base_patch.has_file(fn): raise ValueError("Invalid filename: File does not exist in the base patch.")

    change, isnew = patch.changed_files.get_or_create(
        filename=fn,
        title=fn)

    return redirect(change)

def edit_file(request, patch_id, change_id):
    patch = get_object_or_404(Patch, pk=patch_id)
    if not patch.can_modify(): raise ValueError("This patch cannot be modified.")
    change = get_object_or_404(ChangedFile, patch=patch, pk=change_id)

    return render(request, 'patchmgr/edit_file.html', {
        'patch': patch,
        'change': change,
        'base_text': change.get_base_text(),
        'current_text': change.get_revised_text(),
        })

@json_response
def update_change(request):
    if request.method != "POST": raise Exception()
    print (request.POST["patch"])
    patch = get_object_or_404(Patch, pk=request.POST["patch"])
    if not patch.can_modify(): raise ValueError("This patch cannot be modified.")
    change = get_object_or_404(ChangedFile, patch=patch, pk=request.POST["change"])
    change.set_new_text(request.POST["text"])
    return { "status": "ok" }

@json_response
def render_body(request):
    # pass this off to a separate Node server that can render the page
    import urllib.request, urllib.error, json
    try:
        response = urllib.request.urlopen("http://localhost:8001/render-body", request.POST.get("text").encode("utf8"))
        html = response.read().decode("utf8")
        return { "status": "ok", "html": html }
    except urllib.error.HTTPError as e:
        # error condition should produce JSON
        if e.info()["Content-Type"] == "application/json":
            return json.loads(e.read().decode("utf-8"))
        raise
