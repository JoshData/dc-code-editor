DC Code Editor
==============

A web application, to be run locally, to edit the DC Code and manage the
patch and publishing process.

The editor is built in Django with the help of the codemirror text editor
widget (http://codemirror.net/). Real-time rendering of the Code to HTML
is done with the simple-2 project (https://github.com/openlawdc/simple-2),
which requires also having a separate node server running.

Setup:

	git submodule update --init
	sudo apt-get install libgit2-dev # on Ubuntu, not sure what to do on other systems
	virtualenv --system-site-packages -p`which python3` .env
	. .env/bin/activate
	pip install -r pip-requirements.txt

	cd code_editor_webapp/
	./manage.py syncdb

	cd ../ext/simple-2
	nvm use v0.10.24 # or however you manage your virtual environment for node
	npm install
	node make_index.js ../../code_editor_webapp/code_repository/

	cd ..

To run, you'll need to run both the `simple-2` server and the Django server,
so you'll need to start these in separate terminals.

	# terminal 1
	cd ext/simple-2
	node render_body_server.js ../../code_editor_webapp/code_repository

	# terminal 2
	. .env/bin/activate
	cd code_editor_webapp
	./manage.py runserver
