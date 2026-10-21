"""Serper Google Search backend for Hermes."""
from .provider import SerperWebSearchProvider

def register(ctx):
    ctx.register_web_search_provider(SerperWebSearchProvider())
