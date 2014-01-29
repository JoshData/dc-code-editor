DC Code Editor
==============

A web application, to be run locally, to edit the DC Code and manage the
patch and publishing process.

Setup:

	sudo apt-get install libgit2-dev # on Ubuntu, not sure what to do on other systems
	virtualenv --system-site-packages -p`which python3` .env
	. .env/bin/activate
	pip install -r pip-requirements.txt
