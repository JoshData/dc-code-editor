#Dockerfile for dc-code-editor

FROM ubuntu:14.04

# Maintainer: V. David Zvenyach <dave at esq io> (@vzvenyach)
MAINTAINER V. David Zvenyach, dave@esq.io

# Initialize
RUN sudo apt-get update
RUN mkdir /home/user-data

# Install Git
RUN sudo apt-get install -y git

# Install Node
RUN sudo apt-get -y install nodejs
RUN ln -s /usr/bin/nodejs /usr/bin/node
RUN sudo apt-get -y install npm

#Clone the Editor
RUN cd /home/user-data/ && git clone https://github.com/JoshData/dc-code-editor.git

# pull in external modules and install dependencies
RUN cd /home/user-data/dc-code-editor/ && git submodule update --init && npm install

# install dependencies of simple-2
RUN cd /home/user-data/dc-code-editor/ext/simple-2; npm install

# install dependencies of jot
RUN cd /home/user-data/dc-code-editor/ext/jot; npm install

# download the DC Code
RUN cd /home/user-data/dc-code-editor/ && git clone https://github.com/JoshData/dc-code-prototype base_code

# download forever
RUN sudo npm install -g forever

# Run the editor on build and expose the port
EXPOSE 8000
CMD forever -w start home/user-data/dc-code-editor/editor/index.js