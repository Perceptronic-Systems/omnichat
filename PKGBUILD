# Maintainer: Perceptronic-Systems
pkgname='omnichat-git'
pkgver=0.0.2
pkgrel=1
pkgdesc="A minimal chat interface for LLMs"
arch=('x86_64')
url="https://github.com/Perceptronic-Systems/omnichat"
license=('MIT')
depends=('gtkmm-4.0' 'cpr' 'nlohmann-json' 'python' 'python-flask' 'python-requests' 'python-numpy')
makedepends=('git' 'gcc' 'make')
optdepends=()
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
	mkdir -p "$pkgdir/usr/share/omnichat"
	cp -r ./backend/* "$pkgdir/usr/share/omnichat/"
	install -Dm644 ./frontend/default-stylesheet.css "$pkgdir/usr/share/omnichat/stylesheet.css"
	install -Dm644 ./README.md "$pkgdir/usr/share/doc/omnichat.md"
	install -Dm644 ./LICENSE "$pkgdir/usr/share/licenses/omnichat/LICENSE"
}
