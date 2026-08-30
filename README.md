# PopcornPager

Forward a cinema ticket confirmation to an address of your own, and a minute
later your phone tells you the best moment to step out and whether there is
anything after the credits.

```
🍿 Dune: Part Three · 7:30 PM
🚽 Best break: 70 minutes in, when the snow appears
🎬 Post-credits scene
Sat, Sep 5 · TCL Chinese Theatre · F4, F5
6925 Hollywood Blvd, Los Angeles, CA 90028
```

It is one Cloudflare Worker and one database. Notifications go straight from the
Worker to your phone, with no notification service in between.

## Deploy it

You need a Cloudflare account, Node 24 or newer, and a domain on Cloudflare if
you want to receive email on it.

```bash
npm install && npm run deploy
```

That one command does the rest: keys, database, secrets, deploy, and an inbound
email address on one of your domains. Then, on the phone:

1. Open the `#token=...` link it prints, in Safari.
2. Share button, then **Add to Home Screen**.
3. Open PopcornPager from the home screen and turn notifications on there.

Step 2 is not optional. iOS will not let a web page ask for notification
permission unless it was opened from the home screen.

Last, forward your cinema confirmations to the address the deploy created.
Re-running `npm run deploy` is safe and will not unsubscribe your phone.

## Start over

```bash
npm run reset
```

Deletes the Worker, the database, the inbound address and your local
`.secrets.json`. It lists what it found and asks before removing anything. Your
phone has to be told to allow notifications again after the next deploy.

## More

| | |
| --- | --- |
| [How it works](docs/how-it-works.md) | The pipeline, the models, and why the notification reads the way it does |
| [Reference](docs/reference.md) | Configuration, routes, and development |
| [Troubleshooting](docs/troubleshooting.md) | When notifications stop arriving |

Licensed under the [MIT License](LICENSE).
