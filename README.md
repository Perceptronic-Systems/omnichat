# omnichat

## A fully open-source AI chat interface made for minimalistic setups

Omnichat is a minimalistic AI chat interface for LLMs. It's fully open-source and easily customizable, fitting well into a minimalistic Arch Linux setup. Omnichat can run completely locally and offline, enabling retrival augmented generation (RAG), file accesss, and other custom tools without the need of the web.

## Installation
To install Omnichat on Arch Linux using makepkg, first download the `PKGBUILD` file and place it in a folder on your computer named `omnichat`.

Then, enter the directory of that folder and use makepkg to install the package:
```
cd /path/to/your/folder/omnichat
makepkg -si
```
For this program to work, you must have the ollama service running in the background.
Start Ollama using either `ollama serve` in a new window, or using `sudo systemctl enable ollama --now`

## Usage

Use `omnichat backend start` to launch the backend service.
Then you can use `omnichat chat` to launch a new chat window.
