#include <gtkmm.h>
#include <cpr/cpr.h>
#include <nlohmann/json.hpp>
#include <iostream>
#include <string_view>
#include <unistd.h>

using json = nlohmann::json;

std::string omnichat_api = "http://localhost:5014/";

std::string generate_id(int length) {
    static const char alphanum[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    std::string id;
    id.reserve(length);
    for (int i = 0; i < length; i++) {
        id += alphanum[rand() % (sizeof(alphanum) - 1)];
    }
    return id;
}

std::string SESSION_ID = generate_id(6);

class ChatWindow : public Gtk::Window {
public:
    ChatWindow() {
        set_title("omnichat 1.0");
        set_default_size(500, 600);

        auto m_vbox = Gtk::make_managed<Gtk::Box>(Gtk::Orientation::VERTICAL);
        m_vbox->set_expand(true);
        m_vbox->set_margin(0);
        set_child(*m_vbox);

        m_scrolled_window.set_child(m_chat_display);
        m_scrolled_window.set_expand(true);
        m_scrolled_window.set_policy(Gtk::PolicyType::NEVER, Gtk::PolicyType::AUTOMATIC);
        m_chat_display.set_expand(true);
        m_chat_display.get_style_context()->add_class("chat-view");
        m_vbox->append(m_scrolled_window);

        // INPUT BAR
        m_input_bar.get_style_context()->add_class("input-bar");
        m_input_bar.set_hexpand(true);

        // Multi-line Input Area (GTK-4.0 doesn't have one natively so we have to create our own)
        m_entry_buffer = Gtk::TextBuffer::create();
        m_entry_buffer->set_text("");
        m_entry_text.set_buffer(m_entry_buffer);
        m_entry_text.set_hexpand(true);
        auto controller = Gtk::EventControllerKey::create();
        controller->signal_key_pressed().connect(sigc::mem_fun(*this, &ChatWindow::on_key_pressed), false);
        m_entry_text.add_controller(controller);
        m_entry_container.set_child(m_entry_text);
        m_entry_container.set_policy(Gtk::PolicyType::AUTOMATIC, Gtk::PolicyType::AUTOMATIC);

        m_send_button.set_label("");
        m_send_button.signal_clicked().connect(sigc::mem_fun(*this, &ChatWindow::on_send_message));
        m_send_button.get_style_context()->add_class("send-button");

        m_input_bar.append(m_entry_container);
        m_input_bar.append(m_send_button);
        m_vbox->append(m_input_bar);

        show();
    }

protected:
    bool on_key_pressed(guint keyval, guint keycode, Gdk::ModifierType state) {
        if (keyval == GDK_KEY_Return || keyval == GDK_KEY_KP_Enter) {
            if ((static_cast<guint>(state & Gdk::ModifierType::SHIFT_MASK)) == 0) {
                on_send_message();
                return true;
            }
        }
        return false;
    }

    Glib::Dispatcher dispatcher;
    std::string latest_bot_response;
    Gtk::Label* pending_label;

    void generate_response(std::string user_text) {
        dispatcher.connect([this]{
            if (pending_label) {
                pending_label->set_text(latest_bot_response);
                m_chat_display.show();
                //pending_label = nullptr;
            }
        });
        Gtk::Label* response_label = append_to_chat("Bot", "", "bot-msg");
        pending_label = response_label;

        latest_bot_response = "";
        json request_body = {
            {"prompt", user_text},
            {"id", SESSION_ID}
        };
        cpr::PostAsync(
            cpr::Url{omnichat_api + "generate"},
            cpr::Body{request_body.dump()},
            cpr::Header{{"Content-Type", "application/json"}},
            cpr::WriteCallback{[&](std::string_view data, intptr_t userdata) -> bool {
                if (json::accept(data)) {
                    auto response_json = json::parse(data);
                    std::string next_token = response_json.value("answer_token", "");
                    latest_bot_response = latest_bot_response + next_token;
                    dispatcher.emit();
                }
                return true;
            }}
        );
    }

    void on_send_message() {
        std::string user_text = m_entry_buffer->get_text();
        if (user_text.empty()) return;

        append_to_chat("User", user_text, "user-msg");
        m_entry_buffer->set_text("");
        generate_response(user_text);
    }

    bool auto_adjust() {
        auto adj = m_scrolled_window.get_vadjustment();
        if (adj)
        {
            adj->set_value(adj->get_upper());
        }
        return false;
    }

    Gtk::Label* append_to_chat(const std::string& sender, const std::string& text, const std::string &css_class) {
        auto message_box = Gtk::make_managed<Gtk::Box>(Gtk::Orientation::HORIZONTAL, 3);
        message_box->get_style_context()->add_class("message");
        message_box->set_hexpand(true);

        auto bubble = Gtk::make_managed<Gtk::Box>(Gtk::Orientation::VERTICAL, 5);
        bubble->get_style_context()->add_class("msg-bubble");
        bubble->get_style_context()->add_class(css_class);

        auto label = Gtk::make_managed<Gtk::Label>();
        label->set_text(text);
        label->set_wrap(true);
        label->set_wrap_mode(Pango::WrapMode::WORD_CHAR);
        label->set_halign(Gtk::Align::FILL);
        bubble->append(*label);

        // Puts user messages on the right and bot messages on the left via an invisible box that fills the remaining horizontal space
        auto spacer = Gtk::make_managed<Gtk::Box>();
        spacer->set_hexpand(true);
        if (css_class == "user-msg") {
            message_box->append(*spacer);
            message_box->append(*bubble);
        } else {
            message_box->append(*bubble);
            message_box->append(*spacer);
        }

        m_chat_display.append(*message_box);
        m_chat_display.show();

        Glib::signal_timeout().connect(sigc::mem_fun(*this, &ChatWindow::auto_adjust), 25);
        return label;
    }

    Gtk::Box m_vbox{Gtk::Orientation::VERTICAL};
    Gtk::Box m_input_bar{Gtk::Orientation::HORIZONTAL};
    Gtk::ScrolledWindow m_scrolled_window;
    Gtk::Box m_chat_display{Gtk::Orientation::VERTICAL};
    Gtk::ScrolledWindow m_entry_container;
    Gtk::TextView m_entry_text;
    Glib::RefPtr<Gtk::TextBuffer> m_entry_buffer;
    Gtk::Button m_send_button;

};

int main(int argc, char* argv[]) {
    if (argc >= 2 && std::string(argv[1]) == "chat") {
        auto app = Gtk::Application::create("org.gtkmm.omnichat");

        auto css_provider = Gtk::CssProvider::create();
        try {
            css_provider->load_from_path("/usr/share/omnichat/stylesheet.css");
        } catch (const Gtk::CssParserError& ex) {
            std::cerr << "CSS Error: " << ex.what() << std::endl;
        }

        auto display = Gdk::Display::get_default();
        Gtk::StyleContext::add_provider_for_display(display, css_provider, GTK_STYLE_PROVIDER_PRIORITY_USER);

        app->signal_activate().connect([app]() {
            auto window = new ChatWindow();
            app->add_window(*window);
            window->present();
        });
        return app->run(1, argv);
    } else if (argc >= 3 && std::string(argv[1]) == "backend" && std::string(argv[2]) == "start") {
        system("/usr/lib/omnichat/backend/venv/bin/python /usr/lib/omnichat/backend/main.py");
        return 0;
    } else if (argc == 1) {
        std::cout << "Welcome to omnichat! Use `omnichat backend start` to launch the API and `omnichat chat` to launch the GUI." << std::endl;
        return 0;
    }
}