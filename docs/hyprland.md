# Keeping the reference window on top (Hyprland)

Boogie's floating reference window asks to stay on top of other windows, but Wayland doesn't let
an app decide that for itself: the window manager does. On Hyprland that takes one window rule.
Boogie never edits your Hyprland config, so here is the rule to add by hand.

The window always has the title `Boogie Reference` (Boogie keeps it fixed on purpose so this rule
can find it), and Boogie's windows have the class `boogie-browser`.

## Add it

Make a file `~/.config/hypr/boogie.lua`:

```lua
-- Boogie Browser's reference window: floating, and pinned so it stays above tiled windows
-- and follows you to every workspace.
o.window({ class = "^boogie-browser$", title = "^Boogie Reference$" }, {
  float = true,
  pin = true,
  border_size = 0,
})
```

Then load it from `~/.config/hypr/hyprland.lua`:

```lua
require("hypr.boogie")
```

Hyprland picks up the change when the config is saved. Open a reference window from Boogie to
check it.

## Notes

- The window is transparent and Boogie draws its own opacity slider, so there is no opacity rule
  here.
- `pin` only works on floating windows, which is why the rule sets both. A pinned window stays
  above tiled windows; another floating window you click on can still come in front of it.
- Want it smaller or in a corner by default? Add for example `size = { 480, 640 }` and
  `move = { "(monitor_w-window_w-40)", "(monitor_h*0.06)" }` to the rule.
