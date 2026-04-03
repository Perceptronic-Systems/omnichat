# Maintainer: Perceptronic-Systems
pkgname='omnichat-git'
pkgver=0.0.2
pkgrel=1
pkgdesc="A minimal chat interface for LLMs"
arch=('x86_64')
url="https://github.com/Perceptronic-Systems/omnichat"
license=('MIT')
depends=('gtkmm-4.0' 'cpr' 'nlohmann-json' 'python' 'python-pip')
makedepends=('git' 'gcc' 'make')
optdepends=()
options=('!strip' '!debug')
conflicts=()
install=
source=("omnichat::git+$url")
sha256sums=('SKIP')

build() {
	cd $srcdir/omnichat
	make
}

package() {
	cd $srcdir/omnichat
	install -Dm755 ./omnichat "$pkgdir/usr/bin/omnichat"
	mkdir -p "$pkgdir/usr/lib/omnichat/backend"
	cp -r ./backend/* "$pkgdir/usr/lib/omnichat/backend"
	python -m venv "$pkgdir/usr/lib/omnichat/backend/venv"
	"$pkgdir/usr/lib/omnichat/backend/venv/bin/pip" install -q --no-cache-dir numpy ollama langchain-ollama langchain-chroma langchain langchain-core langchain-community langchain-text-splitters pydantic chromadb flask flask-cors pypdf beautifulsoup4
	chmod +x "$pkgdir/usr/lib/omnichat/backend/main.py"
	install -Dm644 ./frontend/default-stylesheet.css "$pkgdir/usr/share/omnichat/stylesheet.css"
	install -Dm644 ./README.md "$pkgdir/usr/share/doc/omnichat.md"
	install -Dm644 ./LICENSE "$pkgdir/usr/share/licenses/omnichat/LICENSE"
}
