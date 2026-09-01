FROM ghcr.io/lavalink-devs/lavalink:4
COPY lavalink/application.yml /opt/Lavalink/application.yml
COPY lavalink/application.properties /tmp/lavalink/application.properties
ENTRYPOINT ["java","-jar","/opt/Lavalink/Lavalink.jar","--spring.config.additional-location=file:/tmp/lavalink/application.properties"]
