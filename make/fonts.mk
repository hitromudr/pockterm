.PHONY: font-subset

# The pane's font is carried in the binary (web/fonts), because a font stack does
# not carry a face — it picks whatever the machine has, and one screen came out in
# Noto Sans Mono on the phone, DejaVu Sans Mono on Linux and Consolas on Windows.
#
# Kept out of `check` and out of `build`: it needs fonttools and the system Noto
# installed (Debian: fonttools python3-brotli fonts-noto-core), the two .woff2
# files are committed, and a build that regenerated them would make every push
# look like a new binary — which is what CI uses to decide whether to restart
# anybody's terminal.
font-subset: ## Rebuild web/fonts from the system Noto Sans Mono (needs fonttools)
	python3 tools/subset-font.py web/fonts
