DC Code Editor
==============

A web application, to be run locally, to edit the DC Code and manage the
patch and publishing process.

Setup
-----

This repository has been tested with Ubuntu 13.10.

	# clone this repo, activate your nvm, etc.

	# pull in external modules
	git submodule update --init

	# install dependencies
	npm install

	# install dependencies of simple-2
	cd ext/simple-2
	npm install
	cd ../..

	# install dependencies of jot
	cd ext/jot
	npm install
	cd ../..

	# download the DC Code
	git clone https://github.com/JoshData/dc-code-prototype base_code


Run
---

	node editor/index.js

or to have the editor restart after any code changes use:

	npm install -g supervisor
	./run

The open your browser to http://localhost:8000/.

