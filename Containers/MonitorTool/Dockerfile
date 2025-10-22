FROM node:18-alpine

# Create app dir
WORKDIR /usr/src/app

# Copy package files and install
COPY package.json package.json
RUN npm install --production

# Copy source
COPY . .

# Expose port for web UI
EXPOSE 4000

CMD ["node", "index.js"]
