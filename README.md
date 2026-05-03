# omnichat
Welcome to Omnichat C++!
Omnichat C++ is a minimal LLM interface that is fully open source and ready to be customized.
Instead of depending on the web and 3rd party services, Omnichat C++ is capable of running completely locally on your system, enabling retrival augmented generation (RAG), file accesss, and other custom tools.

## Installation
To install Omnichat C++ on Arch Linux using makepkg, first download the `PKGBUILD` file and place it in a folder on your computer named `omnichat`.

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



Enjoy!
