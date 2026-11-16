# Image build and runtime scripts

`build-swarm.sh` and `build.sh` run on the build host. Everything else is copied
into the image by the Dockerfile (desktop, VNC, Pi bake helpers, volume
persistence). `test_*` scripts exercise those helpers on the host; they are
excluded from the image by `.dockerignore`.
