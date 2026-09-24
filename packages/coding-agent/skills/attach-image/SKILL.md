---
name: attach-image
description: Load an on-disk image (PNG, JPEG, GIF, WebP) into the model's context as a viewable attachment so the model can directly SEE it — for screenshots, diagrams, charts, photos, or scanned pages. Use this when you need to perceive an image's visual contents, including when the user pastes an image file path. On a model without vision the host hands the image to the owner's configured image model, which describes it for you; it errors with setup guidance only when no model can see it.
---

# Attach Image

Load on-disk images into the model's context as multimodal attachments. The
image is sent to the model the same way a pasted image is, so the model can
actually look at it.

## When to use this

- The user points at an image file and wants you to look at it.
- You need to read text, a chart, a diagram, or a layout from an image.
- A screenshot needs visual interpretation.

## When NOT to use this

For *programmatic* work on an image — measuring pixels, cropping, resizing,
computing a hash, comparing files byte-by-byte — open it in the kernel with a
library instead:

```python
from PIL import Image
img = Image.open("diagram.png")
print(img.size)
```

That path does not put the image in the model's context; it only lets you
compute over it. Use `attach_image` when you need to *see* the image.

## Usage

Call the prepared `attach_image` import directly in the Python kernel:

```python
print(await attach_image("diagram.png"))
print(await attach_image("a.png", "b.jpg"))
```

The skill automatically resizes and compresses large images before loading them
into context. Animated images that need compression are flattened to their first
frame. Transparent images that need compression are composited onto a neutral
gray background. Extremely large images are rejected by pixel count before full
processing. The original file is left untouched.

Supported formats: PNG, JPEG, GIF, WebP. The skill errors if a file is not a
supported image, if images are turned off in the settings, or if neither the
current model nor a configured image model can see images.

An image the owner pasted shows up in their message as `[image #N](path)`: the
host saved the pasted image at that path, so `attach_image(path)` brings it back
when you need to look at it again later (after a restart, or when an earlier
description does not answer a new question about it).

If you cannot see images yourself, call it anyway rather than handing the file
to a subagent: the next reply comes from the owner's image model, which puts
what it saw into words, and the task then continues with you.
