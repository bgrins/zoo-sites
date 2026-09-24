# zoo-sites

67 fictional websites you can run locally, including shops, banks, government
portals, and newsrooms.

To browse them on one port, with an index at `/`:

```sh
node server.mjs --port 8907
```

To serve each site on its own port (8100–8166):

```sh
node serve.mjs
```

The servers use only Node built-ins. For a container setup, see
[`docker/README.md`](docker/README.md).

The sites also power a [browser-agent eval](eval/). Interaction tasks check what
the servers observe; extraction tasks check published content. If you're adding
a site, start with [`docs/authoring-fixtures.md`](docs/authoring-fixtures.md).

Some sites include a phishing lookalike, deceptive flows, and prompt-injection
text. Keep the servers off public networks and don't enter real credentials.
Sessions live in memory; if you use a proxy, don't cache HTML responses.

## License

Apache-2.0. See `LICENSE`.
