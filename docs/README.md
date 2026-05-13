# docs/

Assets referenced by the top-level README.

## `demo.gif`

The top-level README embeds `docs/demo.gif`. The file currently checked
in is a 1×1 transparent placeholder so the embed renders. Replace it
with a real recording of the `baf` flow whenever convenient.

### Recommended recording flow (vhs)

[`vhs`](https://github.com/charmbracelet/vhs) renders a `.tape` script
to a GIF. It's the simplest path for a deterministic, repeatable
recording.

```sh
brew install vhs
vhs docs/demo.tape          # writes docs/demo.gif
```

A starter `docs/demo.tape` lives next to this file. Tune the typing
speed / pauses to taste, then commit the new `demo.gif`.

### Alternative (asciinema → agg)

If you want a true session capture instead of a scripted one:

```sh
brew install asciinema agg
asciinema rec docs/demo.cast      # records the real session
agg docs/demo.cast docs/demo.gif  # renders to GIF
```

Keep the final file ≤ ~3 MB so GitHub's README renders it inline
without lazy-loading delays.
