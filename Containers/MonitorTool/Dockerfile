FROM node:18-alpine
WORKDIR /usr/src/app
COPY package.json package.json
RUN npm install --production
COPY . .
EXPOSE 4000
CMD ["npm", "start"]
