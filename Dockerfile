FROM node:18

# Install poppler-utils and imagemagick
RUN apt-get update && apt-get install -y poppler-utils imagemagick

# Increase ImageMagick resource limits for large image processing
RUN sed -i 's/<policy domain="resource" name="memory" value=".*"/<policy domain="resource" name="memory" value="4GiB"/' /etc/ImageMagick-6/policy.xml && \
    sed -i 's/<policy domain="resource" name="map" value=".*"/<policy domain="resource" name="map" value="8GiB"/' /etc/ImageMagick-6/policy.xml && \
    sed -i 's/<policy domain="resource" name="disk" value=".*"/<policy domain="resource" name="disk" value="16GiB"/' /etc/ImageMagick-6/policy.xml && \
    sed -i 's/<policy domain="resource" name="area" value=".*"/<policy domain="resource" name="area" value="2GiB"/' /etc/ImageMagick-6/policy.xml

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]