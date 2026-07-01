def greet(name):
    return "hi " + name


class Greeter:
    def hello(self):
        return greet("world")
