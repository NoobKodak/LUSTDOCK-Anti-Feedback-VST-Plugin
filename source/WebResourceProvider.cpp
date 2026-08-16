#include "WebResourceProvider.h"

#include <UiBinaryData.h>

namespace lostduck
{
namespace
{
juce::String mimeTypeFor (const juce::String& filename)
{
    if (filename.endsWithIgnoreCase (".html")) return "text/html;charset=UTF-8";
    if (filename.endsWithIgnoreCase (".js"))   return "text/javascript;charset=UTF-8";
    if (filename.endsWithIgnoreCase (".css"))  return "text/css;charset=UTF-8";
    if (filename.endsWithIgnoreCase (".json")) return "application/json;charset=UTF-8";
    if (filename.endsWithIgnoreCase (".svg"))  return "image/svg+xml";
    if (filename.endsWithIgnoreCase (".png"))  return "image/png";
    if (filename.endsWithIgnoreCase (".jpg")
        || filename.endsWithIgnoreCase (".jpeg")) return "image/jpeg";
    if (filename.endsWithIgnoreCase (".mp3"))  return "audio/mpeg";
    if (filename.endsWithIgnoreCase (".wav"))  return "audio/wav";
    if (filename.endsWithIgnoreCase (".woff2")) return "font/woff2";
    if (filename.endsWithIgnoreCase (".woff"))  return "font/woff";
    if (filename.endsWithIgnoreCase (".ttf"))   return "font/ttf";

    return "application/octet-stream";
}

const char* findResource (const juce::String& filename, int& sizeOut)
{
    for (int i = 0; i < UiBinaryData::namedResourceListSize; ++i)
        if (filename == UiBinaryData::originalFilenames[i])
            return UiBinaryData::getNamedResource (UiBinaryData::namedResourceList[i], sizeOut);

    return nullptr;
}
}

std::optional<juce::WebBrowserComponent::Resource> getWebResource (const juce::String& url)
{
    auto filename = url.upToFirstOccurrenceOf ("?", false, false)
                       .upToFirstOccurrenceOf ("#", false, false);

    if (filename.startsWith ("/"))
        filename = filename.substring (1);

    if (filename.isEmpty())
        filename = "index.html";

    filename = juce::URL::removeEscapeChars (filename).fromLastOccurrenceOf ("/", false, false);

    int size = 0;
    const auto* data = findResource (filename, size);

    if (data == nullptr)
        return std::nullopt;

    const auto* bytes = reinterpret_cast<const std::byte*> (data);

    return juce::WebBrowserComponent::Resource { std::vector<std::byte> (bytes, bytes + size),
                                                 mimeTypeFor (filename) };
}
}
