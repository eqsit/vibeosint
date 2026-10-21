FROM nousresearch/hermes-sandbox:desktop
LABEL org.opencontainers.image.title="VibeOSINT tools sandbox" \
      org.opencontainers.image.description="Project-only OCR, PDF and metadata tools; no account files or credentials"
USER root
COPY sandbox-requirements.txt /opt/vibeosint-tools/requirements.txt
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-rus libimage-exiftool-perl dnsutils whois \
      poppler-utils ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m pip install --no-cache-dir -r /opt/vibeosint-tools/requirements.txt
