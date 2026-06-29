# Use official Node.js parent runtime as base image
FROM node:20-alpine

# Set working directory inside the container
WORKDIR /usr/src/app

# Copy dependency mappings
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy backend source files
COPY . .

# Compile Prisma Client engine binaries
RUN npx prisma generate

# Expose server port
EXPOSE 3001

# Command to boot the Express application
CMD [ "npm", "start" ]
