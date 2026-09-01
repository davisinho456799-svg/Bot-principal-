FROM ghcr.io/lavalink-devs/lavalink:4
COPY lavalink/application.yml /opt/Lavalink/application.yml
ENV SPRING_CONFIG_ADDITIONAL_LOCATION=file:/opt/Lavalink/application.yml
ENV SPRING_APPLICATION_JSON='{"plugins":{"youtube":{"clients":["MUSIC","TV","ANDROID_VR","WEB","WEBEMBEDDED"]}}}'
