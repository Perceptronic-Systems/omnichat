CXX = g++
CXXFLAGS = -std=c++17 $(shell pkg-config --cflags gtkmm-4.0)
LIBS = $(shell pkg-config --libs gtkmm-4.0) -lcpr -lcurl

TARGET = omnichat

all: $(TARGET)

$(TARGET): frontend/omnichat.o
	$(CXX) frontend/omnichat.o -o $(TARGET) $(LIBS)

# Compile the source file into an object file
omnichat.o: frontend/omnichat.cpp
	$(CXX) $(CXXFLAGS) -c frontend/omnichat.cpp -o

clean:
	rm -f *.o $(TARGET)

.PHONY: all clean
