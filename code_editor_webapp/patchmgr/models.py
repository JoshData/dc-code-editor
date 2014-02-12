from django.db import models
from json_field import JSONField

class Patch(models.Model):
    """A patch is a collection of modifications to files, typically caused by the same legal
    action (a single law) and with common effective and expires dates."""

    title = models.CharField(max_length=200,
    	help_text="A descriptive title for this set of changes, such as a DC Law number.")

    created = models.DateTimeField('creation date', auto_now_add=True, db_index=True)
    modified = models.DateTimeField('last modification date', auto_now=True, db_index=True)

    base_patch = models.ForeignKey('Patch', blank=True, null=True, on_delete=models.PROTECT,
    	help_text="Another Patch object that this Patch is applied on top of. In many cases, the base patch is a root patch that refers to a git commit with the base text of the code. For root patches, this is null.")

    commit_hash = models.CharField(max_length=40, blank=True, null=True,
        help_text="For non-root patches, the SHA1 hash (in hex) of the git commmit that this patch was published to.")

    metadata = JSONField(default={}, blank=True,
        help_text="Metadata associated with the change, such as notes, the reason for the chance (e.g. a DC Law number), the effective date, and so on.")

    def __str__(self):
        return "Patch(%d, %s, %s, %s)" % (
            self.id,
            self.created.isoformat(),
            str(self.base_patch) if self.base_patch else self.commit_hash,
            repr(self.title))

    def get_absolute_url(self):
        return "/patch/%d" % self.id

    def get_display_info(self):
        if not self.base_patch:
            return Patch.get_code_repository_commit_info(self.commit_hash)
        return {
            "title": self.title,
            }

    def has_changes(self):
        return self.changed_files.count() > 0

    def can_create_subpatch(self):
        return not self.base_patch or self.has_changes()

    def can_modify(self):
        return self.base_patch

    @staticmethod
    def get_code_repository():
        from django.conf import settings
        from pygit2 import Repository
        return Repository(settings.CODE_REPOSITORY_PATH)

    @staticmethod
    def get_code_repository_branch_head(branch_name=None):
        from django.conf import settings
        if not branch_name: branch_name = settings.CODE_REPOSITORY_MASTER_BRANCH
        repo = Patch.get_code_repository()
        branch = repo.lookup_branch(branch_name)
        if not branch: raise ValueError("There is no %s branch in the git repository." % branch_name)
        return branch.get_object() # it's a commit object

    @staticmethod
    def get_code_repository_commit_info(commit):
        from datetime import datetime
        import lxml.etree

        repo = Patch.get_code_repository()

        if isinstance(commit, str):
            # convert hex string to commit object
            commit = repo[commit]

        # Get metadata about the Code at this commit from the index.xml fileself.
        dom = lxml.etree.fromstring(repo[commit.tree["index.xml"].oid].data)
        recency = dom.find("meta/recency").text

        commit_time = datetime.fromtimestamp(commit.commit_time)

        title = "Published Code as of %s: %s" % (commit_time.strftime("%x"), recency.title())

        # Build a title & description.
        description = \
            dom.find("heading").text \
            + "\n" + recency \
            + "\n\ncommit: " + commit.hex \
            + "\n(" + commit.message[0:50].strip() + ")"

        return {
            "commit": commit.hex,
            "title": title,
            "description": description,
            "commit_time": commit_time,
        }

    @staticmethod
    def get_master_head():
        commit = Patch.get_code_repository_branch_head()
        info = Patch.get_code_repository_commit_info(commit)

        # If a Patch object exists for that commit, return it.
        try:
            return Patch.objects.get(commit_hash=info["commit"])
        except Patch.DoesNotExist:
            pass

        # Create a new Patch object.
        p = Patch(
            title=info["title"] + " | " + info["description"],
            base_patch=None,
            commit_hash=info["commit"],
            )
        p.save()

        # Override the creation/modified dates to reflect the commit date.
        p.created = info["commit_time"]
        p.modified = p.created
        p.save()

        return p

    def get_file_list(self, path=None):
        import re

        if self.base_patch is None:
            # This patch represents the state of the Code repository at a particular commit.
            # Use git to list the files in the Code.
            entry_type_names = { 'Blob': 'file', 'Tree': 'dir'  }
            repo = Patch.get_code_repository()
            commit = repo[self.commit_hash]
            tree = commit.tree
            if path:
                for entry in path.split("/"): # move down the path
                    tree = repo[tree[entry].oid]
            ret = [(entry.name, entry_type_names[type(repo[entry.oid]).__name__]) for entry in tree]

        else:
            # This patch is on top of another patch. Query the base patch for its
            # files, and then add/remove files depending on whether any files are
            # being added or deleted by this patch.
            ret = self.base_patch.get_file_list(path)
            for changed_files in self.changed_files.all():
                # Add the file and any parent directories that are immediate subpaths of
                # of path into the file list, if they are not already present.
                pass # TODO

        ret.sort(key = lambda x : (x[1] is "file", x[0]))
        return ret

    def get_file_content(self, filename):
        if self.base_patch is None:
            # This patch represents the state of the Code repository at a particular commit.
            repo = Patch.get_code_repository()
            commit = repo[self.commit_hash]
            return repo[commit.tree[filename].oid].data

        else:
            # This patch is on top of another patch. Get the file content as of the base patch
            # and then apply any changes indicated in this patch.
            text = self.base_patch.get_file_content(filename)
            for change in self.changed_files.filter(filename=filename):
                text = change.apply(text)
            return text

    def has_file(self, filename):
        entries = self.get_file_list()

        # navigate through the directory structure
        file_path = filename.split("/")
        for i, dirname in enumerate(file_path[:-1]):
            if not (dirname, 'dir') in entries: return False
            entries = self.get_file_list("/".join( file_path[:i+1] ))

        # check that the file exists in the innermost directory
        return (file_path[-1], 'file') in entries


class ChangedFile(models.Model):
    """The changes to a single file. The change is relative to the text of the file in the patch's base_patch."""

    patch = models.ForeignKey(Patch, on_delete=models.PROTECT, related_name="changed_files", help_text="The patch that this change to a file is a part of.")

    filename = models.CharField(max_length=256, help_text="The path of the changed file.")
    title = models.CharField(max_length=200, help_text="A descriptive title for the changes to this file.")

    metadata = JSONField(help_text="Metadata associated with the change, such as notes, the reason for the chance (e.g. a DC Law number with section), the effective date (overriding the same information in the Patch), and so on.")

    diff = JSONField(default={}, help_text="A JSON encoding of change to the file's text.")

    def get_absolute_url(self):
        return "/patch/%d/%d" % (self.patch.id, self.id)

    def get_base_text(self):
        return self.patch.base_patch.get_file_content(self.filename)

    def get_revised_text(self):
        return self.apply(self.get_base_text())

    def apply(self, base_text):
        # Return the content of the file after the change is applied,
        # where the base content is given in base_text. Right now we're
        # storing the complete new text inside the ChangedFile, so just
        # return it.
        if "content" in self.diff:
            return self.diff["content"]
        else:
            return base_text

    def set_new_text(self, new_text):
        self.diff["content"] = new_text
        self.save()
        self.patch.save() # update modified time

        
