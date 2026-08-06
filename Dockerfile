# NEON RUSH - container image.
#
# The application is pure standard library, so this is a single-stage build on
# the slim base. Dependencies in requirements.txt are optional upgrades (see
# that file); the image still starts if the install step is removed.

FROM python:3.11-slim

# Never write .pyc files, never buffer stdout - logs should appear immediately
# in the platform's log viewer rather than being held in a pipe buffer.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

# Copy requirements first so the dependency layer is cached across code edits.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# SQLite needs a writable directory. Declaring it as a volume keeps the
# database off the container's ephemeral layer, so scores survive a restart.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# Run as a non-root user, and give it ownership of the data directory so the
# database can actually be created at runtime.
RUN useradd --create-home --uid 10001 neon \
    && chown -R neon:neon /app
USER neon

EXPOSE 8080

# The server reads $PORT and binds 0.0.0.0 automatically when it is set.
CMD ["python", "run.py"]
